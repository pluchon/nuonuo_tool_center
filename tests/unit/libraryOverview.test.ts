import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { addRoot, getOverview } from '../../src/main/services/libraryService'
import { configureScan, whenScanIdle } from '../../src/main/services/scan/scanService'

let dir: string
let home: string
let sourceA: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-overview-'))
  home = join(dir, 'library')
  sourceA = join(dir, 'pics')
  mkdirSync(join(sourceA, '2024'), { recursive: true })
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  mkdirSync(join(dir, 'thumbs'))
  configureScan({ thumbsDir: join(dir, 'thumbs'), categoryHomeOverride: null })
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('侧栏概况', () => {
  it('新库：计数都是 0，没有源目录；类目录位置还不存在时没有类目录', async () => {
    expect(await getOverview(home)).toEqual({
      counts: { total: 0, tagged: 0, untagged: 0, recent: 0, r18: 0, tags: 0, aiSuggest: 0 },
      sources: [],
      categories: [],
      lastScanAt: null
    })
  })

  it('类目录：列出类目录位置下的顶层文件夹，标出有没有子文件夹，跳过隐藏和系统目录', async () => {
    mkdirSync(join(home, '壁纸精选', '横屏'), { recursive: true })
    mkdirSync(join(home, '猫猫'), { recursive: true })
    mkdirSync(join(home, '.cache'), { recursive: true })
    mkdirSync(join(home, '$RECYCLE.BIN'), { recursive: true })
    const { categories } = await getOverview(home)
    expect(categories).toEqual([
      { name: '壁纸精选', count: 0, hasChildren: true },
      { name: '猫猫', count: 0, hasChildren: false }
    ])
  })

  it('导入源目录：不能和类目录位置重叠，不能重复导入', async () => {
    await expect(addRoot(join(home, '猫猫'), home)).rejects.toThrow('类目录')
    await expect(addRoot(dir, home)).rejects.toThrow('类目录')
    const created = await addRoot(sourceA, home)
    expect(created.name).toBe('pics')
    await whenScanIdle()
    await expect(addRoot(join(sourceA, '2024'), home)).rejects.toThrow('重叠')
    await expect(addRoot(join(dir, 'missing'), home)).rejects.toThrow('目录不存在')
  })

  it('计数：全部图片只算打过标签的，删进回收站的不算，同一张图的多个位置只算一张', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, is_r18) VALUES ('a', 'jpg', 1, false), ('b', 'png', 1, true), ('c', 'jpg', 1, false);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime, status) VALUES
        (1, 1, 'a.jpg', now(), 'NORMAL'), (1, 1, '2024\\a.jpg', now(), 'NORMAL'),
        (2, 1, 'b.png', now(), 'MISSING'),
        (3, 1, 'c.jpg', now(), 'DELETED');
      INSERT INTO tag (name, category_id) VALUES ('甘雨', 1);
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (1, 1, 'MANUAL', 'ACCEPTED'), (2, 1, 'VLM', 'SUGGESTED');
    `)
    const ov = await getOverview(home)
    expect(ov.counts).toEqual({ total: 2, tagged: 1, untagged: 1, recent: 2, r18: 1, tags: 1, aiSuggest: 0 })
    expect(ov.sources).toEqual([{ id: 1, name: 'pics', path: sourceA, count: 2, hasChildren: true, offline: false }])
  })
})
