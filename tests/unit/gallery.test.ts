import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GalleryQueryDTO } from '../../src/shared/api'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { getImageDetail, listGallery } from '../../src/main/services/galleryService'

let dir: string
let source: string
let library: string

// 查一个视图，只看名字
async function names(q: Partial<GalleryQueryDTO> & Pick<GalleryQueryDTO, 'view'>): Promise<string[]> {
  const { items } = await listGallery({ sort: 'name', ...q })
  return items.map((i) => i.name)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-gallery-'))
  source = join(dir, 'pics')
  library = join(dir, 'library')
  mkdirSync(join(source, 'sub'), { recursive: true })
  mkdirSync(join(library, '猫猫', '小猫'), { recursive: true })
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  const { pg } = getDatabase()
  // 1 号源目录在线；2 号源目录找不到；3 号是类目录
  await pg.query(
    `INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1), ('SOURCE', 'gone', $2), ('CATEGORY', '类目录', $3)`,
    [source, join(dir, 'gone'), library]
  )
  await pg.exec(`
    INSERT INTO image (content_hash, format, byte_size, width, height, display_name, is_r18, thumb_ready, create_time, taken_at) VALUES
      ('h1', 'JPG', 300, 100, 50, NULL, false, 1, now() - interval '1 day', '2025-10-03 09:00:00+08'),
      ('h2', 'PNG', 100, 50, 100, '甘雨-好椰', false, 1, now() - interval '2 day', NULL),
      ('h3', 'RAW', 900, NULL, NULL, NULL, true, 2, now() - interval '60 day', '2024-01-01 00:00:00+08'),
      ('h4', 'GIF', 50, 10, 10, NULL, false, 0, now() - interval '3 day', NULL),
      ('h5', 'JPG', 10, 10, 10, NULL, false, 1, now() - interval '4 day', NULL);
    INSERT INTO image_file (image_id, root_id, rel_path, mtime, status) VALUES
      (1, 1, 'a10.jpg', now(), 'NORMAL'),
      (1, 1, 'sub\\a10-copy.jpg', now(), 'NORMAL'),
      (2, 1, 'sub\\b.png', now(), 'MISSING'),
      (3, 2, 'c.arw', now(), 'NORMAL'),
      (4, 3, '猫猫\\d.gif', now(), 'NORMAL'),
      (4, 3, '猫猫\\小猫\\d.gif', now(), 'NORMAL'),
      (5, 1, 'a9.jpg', now(), 'DELETED');
    INSERT INTO tag (name, category_id) VALUES ('原神', 2);
    INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (2, 1, 'MANUAL', 'ACCEPTED'), (3, 1, 'MANUAL', 'ACCEPTED');
  `)
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('网格数据', () => {
  it('各视图：全部只要打过标签的，还没打标签、最近导入、R-18 各自过滤；删进回收站的不出现', async () => {
    expect(await names({ view: 'all' })).toEqual(['c.arw', '甘雨-好椰'])
    expect(await names({ view: 'untagged' })).toEqual(['a10.jpg', 'd.gif'])
    expect(await names({ view: 'recent' })).toEqual(['a10.jpg', 'd.gif', '甘雨-好椰'])
    expect(await names({ view: 'r18' })).toEqual(['c.arw'])
    expect(await names({ view: 'all', onlyR18: true })).toEqual(['c.arw'])
  })

  it('同一内容多个位置只出一张；源目录、类目录、只看当前目录', async () => {
    expect(await names({ view: 'source', sourceId: 1 })).toEqual(['a10.jpg', '甘雨-好椰'])
    expect(await names({ view: 'source', sourceId: 1, onlyHere: true })).toEqual(['a10.jpg'])
    expect(await names({ view: 'category', category: '猫猫' })).toEqual(['d.gif'])
    expect(await names({ view: 'category', category: '猫猫', onlyHere: true })).toEqual(['d.gif'])
    expect(await names({ view: 'category', category: '小猫' })).toEqual([])
    await expect(listGallery({ view: 'source', sourceId: 3, sort: 'new' })).rejects.toThrow('源目录')
  })

  it('搜索：按名字；全部图片里标签名也算；通配符当普通字符', async () => {
    expect(await names({ view: 'all', q: '好椰' })).toEqual(['甘雨-好椰'])
    expect(await names({ view: 'all', q: '原神' })).toEqual(['c.arw', '甘雨-好椰'])
    expect(await names({ view: 'source', sourceId: 1, q: 'A1' })).toEqual(['a10.jpg'])
    expect(await names({ view: 'untagged', q: '%' })).toEqual([])
  })

  it('排序和状态：拍摄时间没有的排后面；文件不见了、目录找不到、缩略图状态', async () => {
    const byTaken = await listGallery({ view: 'recent', sort: 'taken' })
    expect(byTaken.items.map((i) => i.name)).toEqual(['a10.jpg', '甘雨-好椰', 'd.gif'])
    const bySize = await listGallery({ view: 'all', sort: 'size' })
    expect(bySize.items.map((i) => i.byteSize)).toEqual([900, 100])
    const [raw, png] = bySize.items
    expect(raw).toMatchObject({ offline: true, missing: false, thumb: 'FAILED', isR18: true, tagged: true })
    expect(png).toMatchObject({ offline: false, missing: true, thumb: 'READY' })
    const pending = (await listGallery({ view: 'untagged', sort: 'name' })).items.find((i) => i.name === 'd.gif')
    expect(pending?.thumb).toBe('PENDING')
  })

  it('详情：所有位置的完整路径', async () => {
    const d = await getImageDetail(1)
    expect(d).toMatchObject({ name: 'a10.jpg', width: 100, height: 50, format: 'JPG' })
    expect(d.locations.map((l) => l.path)).toEqual([join(source, 'a10.jpg'), join(source, 'sub', 'a10-copy.jpg')])
    await expect(getImageDetail(5)).rejects.toThrow('不在图库')
  })
})
