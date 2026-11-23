import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FileOpDoneVO } from '../../src/shared/api'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { getImageDetail, listGallery } from '../../src/main/services/galleryService'
import {
  configureFileOps,
  deleteImages,
  flushPendingDeletes,
  recoverFileOps,
  settleFileOps,
  undoDelete
} from '../../src/main/services/fileOps/fileOpsService'
import { hideImageFiles, insertBatch } from '../../src/main/repositories/fileOpRepository'
import { hashBuffer } from '../../src/main/services/scan/imageProbe'

let dir: string
let source: string
let bin: string
const done: FileOpDoneVO[] = []

// 假回收站：把文件挪进 bin 目录；路径里带 locked 的模拟“被占用”删不掉
async function fakeTrash(path: string): Promise<void> {
  if (path.includes('locked')) {
    throw new Error('文件被占用')
  }
  renameSync(path, join(bin, `${Date.now()}-${Math.random()}`))
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-fileops-'))
  source = join(dir, 'pics')
  bin = join(dir, 'bin')
  mkdirSync(join(source, 'sub'), { recursive: true })
  mkdirSync(bin)
  const names = ['a.jpg', 'b.jpg', 'c.jpg', 'locked.jpg', 'e.jpg']
  for (const f of names) {
    writeFileSync(join(source, f), f)
  }
  writeFileSync(join(source, 'sub', 'a-copy.jpg'), 'a.jpg')
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  const { pg } = getDatabase()
  await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
  // 1 号图有两个位置（a.jpg 和 sub\a-copy.jpg）
  for (const name of names) {
    await pg.query("INSERT INTO image (content_hash, format, byte_size) VALUES ($1, 'JPG', $2)", [hashBuffer(Buffer.from(name)), name.length])
  }
  await pg.exec(`
    INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
      (1, 1, 'a.jpg', now()), (2, 1, 'b.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'locked.jpg', now()), (5, 1, 'e.jpg', now()), (1, 1, 'sub\\a-copy.jpg', now());
  `)
  configureFileOps({ trash: fakeTrash, onDone: (r) => done.push(r) })
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

const sourceIds = async (): Promise<number[]> =>
  (await listGallery({ view: 'source', sourceId: 1, sort: 'name' })).items.map((i) => i.imageId).sort((a, b) => a - b)

describe('文件操作：删除', () => {
  it('删除后立刻从图库里藏起来，撤销后回来，文件一直没动', async () => {
    const res = await deleteImages({ view: 'source', sourceId: 1, sort: 'new' }, [2])
    expect(res).toMatchObject({ images: 1, skipped: 0 })
    expect(await sourceIds()).toEqual([1, 3, 4, 5])
    expect(existsSync(join(source, 'b.jpg'))).toBe(true)
    await undoDelete(res.batchId)
    expect(await sourceIds()).toEqual([1, 2, 3, 4, 5])
    await flushPendingDeletes()
    expect(existsSync(join(source, 'b.jpg'))).toBe(true)
  })

  it('执行后文件进回收站，撤销来不及了', async () => {
    const res = await deleteImages({ view: 'source', sourceId: 1, sort: 'new', onlyHere: false }, [3])
    await flushPendingDeletes()
    expect(existsSync(join(source, 'c.jpg'))).toBe(false)
    expect(done.at(-1)).toMatchObject({ batchId: res.batchId, done: 1, failed: 0 })
    await expect(undoDelete(res.batchId)).rejects.toThrow('回收站')
    expect(await sourceIds()).toEqual([1, 2, 4, 5])
  })

  it('全部位置：在“最近导入”里删 1 号图，两个位置都进回收站，图片记录留着', async () => {
    await deleteImages({ view: 'recent', sort: 'new' }, [1])
    await flushPendingDeletes()
    expect(existsSync(join(source, 'a.jpg'))).toBe(false)
    expect(existsSync(join(source, 'sub', 'a-copy.jpg'))).toBe(false)
    await expect(getImageDetail(1)).rejects.toThrow('不在图库')
    const { pg } = getDatabase()
    const rows = await pg.query<{ n: number }>(`SELECT count(*)::int n FROM image WHERE id = 1 AND delete_state = 0`)
    expect(rows.rows[0].n).toBe(1)
  })

  it('删不掉的（被占用）恢复成正常并报原因', async () => {
    await deleteImages({ view: 'source', sourceId: 1, sort: 'new' }, [4])
    await flushPendingDeletes()
    expect(done.at(-1)).toMatchObject({ done: 0, failed: 1, error: '文件被占用' })
    expect(await sourceIds()).toContain(4)
  })

  it('等待回收时外部程序替换了同名文件或目录，保留替换后的内容', async () => {
    const path = join(source, 'b.jpg')
    const bytes = readFileSync(path)
    try {
      for (const replacement of ['file', 'directory']) {
        const res = await deleteImages({ view: 'source', sourceId: 1, sort: 'new' }, [2])
        if (replacement === 'file') {
          writeFileSync(path, 'other')
        } else {
          rmSync(path)
          mkdirSync(path)
          writeFileSync(join(path, '保留.txt'), 'other')
        }
        await flushPendingDeletes()
        expect(done.at(-1)).toMatchObject({ batchId: res.batchId, done: 0, failed: 1 })
        expect(readFileSync(replacement === 'file' ? path : join(path, '保留.txt'), 'utf8')).toBe('other')
        rmSync(path, { recursive: true })
        writeFileSync(path, bytes)
      }
    } finally {
      if (existsSync(path)) rmSync(path, { recursive: true })
      writeFileSync(path, bytes)
    }
  })

  it('等待回收时源目录离线，接回后图片和索引都保留', async () => {
    const res = await deleteImages({ view: 'source', sourceId: 1, sort: 'new' }, [2])
    const offline = join(dir, 'offline')
    renameSync(source, offline)
    try {
      await flushPendingDeletes()
      expect(done.at(-1)).toMatchObject({ batchId: res.batchId, done: 0, failed: 1 })
    } finally {
      renameSync(offline, source)
    }
    expect(await sourceIds()).toContain(2)
    expect(existsSync(join(source, 'b.jpg'))).toBe(true)
  })

  it('崩溃后启动：上次没执行的删除按日志补做', async () => {
    // 模拟崩溃：日志写了、文件藏起来了，但定时器随进程没了
    await getDatabase().db.transaction(async (tx) => {
      await insertBatch(tx, '删除 1 张', [{ opType: 'DELETE', imageFileId: 5, fromPath: join(source, 'e.jpg'), toPath: null, contentHash: hashBuffer(Buffer.from('e.jpg')) }])
      await hideImageFiles(tx, [5])
    })
    expect(await recoverFileOps()).toBe(1)
    await settleFileOps()
    expect(existsSync(join(source, 'e.jpg'))).toBe(false)
    expect(await recoverFileOps()).toBe(0)
  })

  it('从回收站还原后能在同一位置重新登记（旧记录已逻辑删除，不撞唯一约束）', async () => {
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (2, 1, 'c.jpg', now())`)
    const rows = await pg.query<{ n: number }>(`SELECT count(*)::int n FROM image_file WHERE rel_path = 'c.jpg' AND delete_state = 0`)
    expect(rows.rows[0].n).toBe(1)
  })

  it('参数校验', async () => {
    await expect(deleteImages({ view: 'all', sort: 'new' }, [])).rejects.toThrow('没有选中')
    await expect(deleteImages({ view: 'all', sort: 'new' }, [999])).rejects.toThrow('不在图库')
  })
})
