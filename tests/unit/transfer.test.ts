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
import { hashBuffer } from '../../src/main/services/scan/imageProbe'

let dir: string
let source: string
let library: string
let bin: string

const ALL = { view: 'all', sort: 'new' } as const
const otherVolume = process.env.LTM_TEST_OTHER_VOLUME

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
  for (const value of ['A', 'B', 'OTHER']) {
    await pg.query("INSERT INTO image (content_hash, format, byte_size) VALUES ($1, 'JPG', $2)", [hashBuffer(Buffer.from(value)), value.length])
  }
  await pg.exec(`
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
  it('同名源文件已被替换时，移动和复制都保留现场及原索引', async () => {
    const from = join(source, 'a.jpg')
    const target = join(library, '猫猫')
    writeFileSync(from, 'X')
    try {
      for (const result of [await copyImages(ALL, [1], [target]), await moveImages(ALL, [1], target)]) {
        expect(result).toMatchObject({ done: 0, failed: 1, error: expect.stringContaining('文件已经更换') })
      }
      expect(await where(1)).toEqual(['pics\\a.jpg'])
      expect(readFileSync(from, 'utf8')).toBe('X')
      expect(existsSync(join(target, 'a.jpg'))).toBe(false)
    } finally { writeFileSync(from, 'A') }
  })

  it('连续移动同一张图，后一个操作从前一个操作完成的位置读取', async () => {
    const [first, second] = await Promise.all([moveImages(ALL, [1], join(library, '猫猫')), moveImages(ALL, [1], source)])
    expect([first.done, second.done]).toEqual([1, 1])
    expect(await where(1)).toEqual(['pics\\a.jpg'])
  })

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

  it('恢复旧版日志时，无法证明归属的空文件及同名文件都保留', async () => {
    writeFileSync(join(source, 'sub', 'keep.jpg'), 'USER')
    writeFileSync(join(source, 'sub', 'a (9).jpg'), '')
    const { db } = getDatabase()
    const batchId = await db.transaction(async (tx) => {
      const id = await insertBatch(tx, '移动 2 张', [
        { opType: 'MOVE', imageFileId: 1, fromPath: join(source, 'a.jpg'), toPath: null, contentHash: hashBuffer(Buffer.from('A')) },
        { opType: 'MOVE', imageFileId: 1, fromPath: join(source, 'a.jpg'), toPath: null, contentHash: hashBuffer(Buffer.from('A')) }
      ])
      await updateBatchStatus(tx, id, 'APPLYING')
      return id
    })
    const [first] = await findPendingOps(batchId)
    await updateOpToPath(db, first.id, join(source, 'sub', 'a (9).jpg'))
    await recoverFileOps()
    await settleFileOps()
    expect(readFileSync(join(source, 'sub', 'a (9).jpg'))).toHaveLength(0)
    expect(readFileSync(join(source, 'sub', 'keep.jpg'), 'utf8')).toBe('USER')
    expect(existsSync(join(source, 'a.jpg'))).toBe(true)
  })

  it('源磁盘中途断开，重启恢复保留用户放在目标位置的零字节文件', async () => {
    const { db } = getDatabase()
    const to = join(library, '猫猫', '用户的空文件.jpg')
    const removed = join(dir, '未连接')
    writeFileSync(to, '')
    await db.transaction(async (tx) => {
      const id = await insertBatch(tx, '移动中断', [{
        opType: 'MOVE', imageFileId: 1, fromPath: join(source, 'a.jpg'), toPath: to, contentHash: hashBuffer(Buffer.from('A'))
      }])
      await updateBatchStatus(tx, id, 'APPLYING')
    })
    renameSync(source, removed)
    try {
      await recoverFileOps()
      expect(readFileSync(to)).toHaveLength(0)
    } finally {
      renameSync(removed, source)
    }
    expect(await where(1)).toEqual(['pics\\a.jpg'])
  })

  it('真实复制成功但索引无法提交，重启只补副本位置，无须再次复制', async () => {
    const { pg } = getDatabase()
    const target = join(library, '提交中断')
    mkdirSync(target)
    writeFileSync(join(target, 'a.jpg'), '原有文件')
    await pg.exec(`
      CREATE FUNCTION reject_test_copy() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '模拟索引写入中断'; END $$;
      CREATE TRIGGER reject_test_copy BEFORE INSERT ON image_file FOR EACH ROW EXECUTE FUNCTION reject_test_copy();
    `)
    try {
      await expect(copyImages(ALL, [1], [target])).rejects.toThrow()
      expect(readFileSync(join(target, 'a (2).jpg'), 'utf8')).toBe('A')
      expect(await where(1)).toEqual(['pics\\a.jpg'])
    } finally {
      await pg.exec('DROP TRIGGER reject_test_copy ON image_file; DROP FUNCTION reject_test_copy();')
    }
    expect(await recoverFileOps()).toBe(1)
    expect(await where(1)).toEqual(['library\\提交中断\\a (2).jpg', 'pics\\a.jpg'])
    expect(readFileSync(join(target, 'a.jpg'), 'utf8')).toBe('原有文件')
    expect(await recoverFileOps()).toBe(0)
    expect(existsSync(join(target, 'a (3).jpg'))).toBe(false)
  })

  it('撤销移动或复制前目标被同名文件替换，保留新文件', async () => {
    const out = join(dir, '撤销冲突')
    mkdirSync(out)
    const target = join(out, 'a.jpg')
    const original = join(source, 'a.jpg')
    const copy = await copyImages(ALL, [1], [out])
    writeFileSync(target, 'C')
    expect(await undoTransfer(copy.batchId)).toMatchObject({ done: 0, failed: 1 })
    expect(readFileSync(target, 'utf8')).toBe('C')
    rmSync(target)
    const move = await moveImages(ALL, [1], out)
    writeFileSync(target, 'M')
    expect(await undoTransfer(move.batchId)).toMatchObject({ done: 0, failed: 1 })
    expect(readFileSync(target, 'utf8')).toBe('M')
    expect(existsSync(original)).toBe(false)
  })

  it('移动中断后占位文件被替换，重启时保留该文件', async () => {
    const from = join(source, 'sub', 'b (2).jpg')
    const to = join(library, '猫猫', '故障留存.jpg')
    writeFileSync(to, '这是一张后来放进来的图片')
    const { db } = getDatabase()
    await db.transaction(async (tx) => {
      const batch = await insertBatch(tx, '移动中断', [{
        opType: 'MOVE', imageFileId: 2, fromPath: from, toPath: to, contentHash: hashBuffer(Buffer.from('B'))
      }])
      await updateBatchStatus(tx, batch, 'APPLYING')
    })
    await recoverFileOps()
    expect(readFileSync(to, 'utf8')).toBe('这是一张后来放进来的图片')
    expect(readFileSync(from, 'utf8')).toBe('B')
  })

  it('改名已写入磁盘但索引事务尚未提交，重启恢复原图片的位置', async () => {
    const from = join(source, 'sub', 'b (2).jpg')
    const to = join(library, '猫猫', '移动完成.jpg')
    renameSync(from, to)
    const { db } = getDatabase()
    await db.transaction(async (tx) => {
      const batch = await insertBatch(tx, '移动中断', [{
        opType: 'MOVE', imageFileId: 2, fromPath: from, toPath: to, contentHash: hashBuffer(Buffer.from('B'))
      }])
      await updateBatchStatus(tx, batch, 'APPLYING')
    })
    await recoverFileOps()
    expect(await where(2)).toEqual(['library\\猫猫\\移动完成.jpg'])
    expect(await recoverFileOps()).toBe(0)
  })

  it.skipIf(!otherVolume)('实际跨卷移动和撤销保留原有同名文件', async () => {
    const output = mkdtempSync(join(otherVolume!, 'ltm-transfer-'))
    const original = join(source, 'sub', 'b.jpg')
    try {
      writeFileSync(join(output, 'b.jpg'), '要保留的文件')
      const moved = await moveImages(ALL, [3], output)
      expect(moved).toMatchObject({ done: 1, failed: 0 })
      expect(readFileSync(join(output, 'b (2).jpg'), 'utf8')).toBe('OTHER')
      expect(existsSync(original)).toBe(false)
      expect(await undoTransfer(moved.batchId)).toMatchObject({ done: 1, failed: 0 })
      expect(readFileSync(original, 'utf8')).toBe('OTHER')
      expect(readFileSync(join(output, 'b.jpg'), 'utf8')).toBe('要保留的文件')
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
