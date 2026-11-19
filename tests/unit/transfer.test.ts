import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { getImageDetail } from '../../src/main/services/galleryService'
import { configureFileOps, recoverFileOps, settleFileOps } from '../../src/main/services/fileOps/fileOpsService'
import { configureTransfer, copyImages, moveImages, undoTransfer } from '../../src/main/services/fileOps/transferService'
import { insertBatch, updateBatchStatus, updateOpToPath, findPendingOps } from '../../src/main/repositories/fileOpRepository'
import { updateSettings } from '../../src/main/services/settingsService'

let dir: string
let source: string
let library: string
let bin: string

const ALL = { view: 'all', sort: 'new' } as const

// 一张图现在在哪些位置（相对 dir 的路径）
async function where(imageId: number): Promise<string[]> {
  const d = await getImageDetail(imageId)
  return d.locations.map((l) => l.path.slice(dir.length + 1)).sort()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-transfer-'))
  source = join(dir, 'pics')
  library = join(dir, 'library')
  bin = join(dir, 'bin')
  mkdirSync(join(source, 'sub'), { recursive: true })
  mkdirSync(join(library, '猫猫'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(source, 'a.jpg'), 'A')
  writeFileSync(join(source, 'b.jpg'), 'B')
  writeFileSync(join(source, 'sub', 'b.jpg'), 'OTHER')
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  await updateSettings({ categoryHome: library })
  const { pg } = getDatabase()
  await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
  await pg.exec(`
    INSERT INTO image (content_hash, format, byte_size) VALUES ('ha', 'JPG', 1), ('hb', 'JPG', 1), ('hx', 'JPG', 5);
    INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, 'a.jpg', now()), (2, 1, 'b.jpg', now()), (3, 1, 'sub\\b.jpg', now());
  `)
  configureTransfer(library)
  configureFileOps({
    trash: async (p) => renameSync(p, join(bin, `${Date.now()}-${Math.random()}`)),
    onDone: () => undefined
  })
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('文件操作：移动和复制', () => {
  it('移动到子文件夹：文件和记录都过去；重名自动加编号，不覆盖已有文件', async () => {
    const res = await moveImages(ALL, [1, 2], join(source, 'sub'))
    expect(res).toMatchObject({ done: 2, skipped: 0, failed: 0 })
    expect(await where(1)).toEqual(['pics\\sub\\a.jpg'])
    expect(await where(2)).toEqual(['pics\\sub\\b (2).jpg'])
    expect(readFileSync(join(source, 'sub', 'b.jpg'), 'utf8')).toBe('OTHER')
    expect(existsSync(join(source, 'a.jpg'))).toBe(false)
    // 已经在那里的跳过
    expect(await moveImages(ALL, [1], join(source, 'sub'))).toMatchObject({ batchId: null, done: 0, skipped: 1 })
  })

  it('撤销移动：挪回原处', async () => {
    const res = await moveImages(ALL, [1], source)
    expect(await where(1)).toEqual(['pics\\a.jpg'])
    const back = await moveImages(ALL, [1], join(library, '猫猫'))
    expect(await where(1)).toEqual(['library\\猫猫\\a.jpg'])
    expect(await undoTransfer(back.batchId)).toMatchObject({ done: 1, failed: 0 })
    expect(await where(1)).toEqual(['pics\\a.jpg'])
    expect(existsSync(join(library, '猫猫', 'a.jpg'))).toBe(false)
    await expect(undoTransfer(back.batchId)).rejects.toThrow('不能撤销')
    expect(res.done).toBe(1)
  })

  it('复制到多个目录：同一张图多几个位置；已有副本的跳过；撤销后复制出来的进回收站', async () => {
    const res = await copyImages(ALL, [1], [join(library, '猫猫'), join(source, 'sub')])
    expect(res).toMatchObject({ done: 2, skipped: 0 })
    expect(await where(1)).toEqual(['library\\猫猫\\a.jpg', 'pics\\a.jpg', 'pics\\sub\\a.jpg'])
    expect(readFileSync(join(library, '猫猫', 'a.jpg'), 'utf8')).toBe('A')
    expect(await copyImages(ALL, [1], [join(library, '猫猫')])).toMatchObject({ done: 0, skipped: 1 })
    expect(await undoTransfer(res.batchId)).toMatchObject({ done: 2 })
    expect(await where(1)).toEqual(['pics\\a.jpg'])
    expect(existsSync(join(library, '猫猫', 'a.jpg'))).toBe(false)
  })

  it('目标目录要存在；至少选一个', async () => {
    await expect(copyImages(ALL, [1], [])).rejects.toThrow('先选')
    await expect(moveImages(ALL, [1], join(source, 'nope'))).rejects.toThrow('找不到')
  })

  it('其他位置（图库外）：复制等于导出一份，图库不变；移动等于移出图库，撤销挪回来', async () => {
    const out = join(dir, 'elsewhere')
    mkdirSync(out)
    writeFileSync(join(out, 'a.jpg'), 'SOMEONE ELSE')
    const before = await where(1)
    const copied = await copyImages(ALL, [1], [out])
    expect(copied).toMatchObject({ done: 1, failed: 0 })
    // 同名不覆盖，加编号；图库里的位置不变
    expect(readFileSync(join(out, 'a.jpg'), 'utf8')).toBe('SOMEONE ELSE')
    expect(readFileSync(join(out, 'a (2).jpg'), 'utf8')).toBe('A')
    expect(await where(1)).toEqual(before)
    // 撤销导出：复制出来的进回收站
    await undoTransfer(copied.batchId)
    expect(existsSync(join(out, 'a (2).jpg'))).toBe(false)

    const moved = await moveImages(ALL, [1], out)
    expect(moved).toMatchObject({ done: 1, failed: 0 })
    expect(readFileSync(join(out, 'a (2).jpg'), 'utf8')).toBe('A')
    // 移出图库：这张图没有位置了（名字、标签还在），列表里也就没有它
    await expect(getImageDetail(1)).rejects.toThrow()
    expect(await undoTransfer(moved.batchId)).toMatchObject({ done: 1, failed: 0 })
    expect(await where(1)).toEqual(before)
    expect(existsSync(join(out, 'a (2).jpg'))).toBe(false)
  })

  it('崩溃后收尾：只清理日志里记下的占位文件，没记目标的不动别人的同名文件', async () => {
    writeFileSync(join(source, 'sub', 'keep.jpg'), 'USER')
    writeFileSync(join(source, 'sub', 'a (9).jpg'), '')
    const { db } = getDatabase()
    const batchId = await db.transaction(async (tx) => {
      const id = await insertBatch(tx, '移动 2 张', [
        { opType: 'MOVE', imageFileId: 1, fromPath: join(source, 'a.jpg'), toPath: null, contentHash: 'ha' },
        { opType: 'MOVE', imageFileId: 1, fromPath: join(source, 'a.jpg'), toPath: null, contentHash: 'ha' }
      ])
      await updateBatchStatus(tx, id, 'APPLYING')
      return id
    })
    const [first] = await findPendingOps(batchId)
    await updateOpToPath(db, first.id, join(source, 'sub', 'a (9).jpg'))
    await recoverFileOps()
    await settleFileOps()
    expect(existsSync(join(source, 'sub', 'a (9).jpg'))).toBe(false)
    expect(readFileSync(join(source, 'sub', 'keep.jpg'), 'utf8')).toBe('USER')
    expect(existsSync(join(source, 'a.jpg'))).toBe(true)
  })
})
