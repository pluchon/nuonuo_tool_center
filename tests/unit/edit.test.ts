import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GalleryItemVO } from '../../src/shared/api'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { getImageDetail, listGallery, listUntaggedDirs, matchMore } from '../../src/main/services/galleryService'
import { addTag, getTagCatalog, removeTag, renameImage, setR18 } from '../../src/main/services/imageEditService'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-edit-'))
  const source = join(dir, 'pics')
  const library = join(dir, 'library')
  mkdirSync(source, { recursive: true })
  mkdirSync(join(library, '猫猫'), { recursive: true })
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  const { pg } = getDatabase()
  await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1), ('CATEGORY', '类目录', $2)`, [source, library])
  // 1–6 号图在源目录，7 号在类目录“猫猫”里
  await pg.exec(`
    INSERT INTO image (content_hash, format, byte_size, width, height) VALUES
      ('h1', 'JPG', 100, 4000, 3000), ('h2', 'PNG', 2000000, 1000, 1000), ('h3', 'JPG', 20000000, 900, 1600),
      ('h4', 'GIF', 10, 10, 10), ('h5', 'JPG', 10, 10, 10), ('h6', 'JPG', 10, 10, 10), ('h7', 'JPG', 10, 10, 10);
    INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
      (1, 1, 'a.jpg', now()), (2, 1, 'b.png', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.gif', now()),
      (5, 1, 'e.jpg', now()), (6, 1, 'f.jpg', now()), (7, 2, '猫猫\\g.jpg', now());
    INSERT INTO tag (name, category_id) VALUES ('甘雨', 1);
    INSERT INTO tag_alias (tag_id, name) VALUES (1, 'Ganyu');
  `)
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('编辑', () => {
  it('改名：去空格，清空用回文件名，超过 15 个字拒绝', async () => {
    expect(await renameImage(1, '  甘雨-好椰表情包 ')).toBe('甘雨-好椰表情包')
    expect((await getImageDetail(1)).name).toBe('甘雨-好椰表情包')
    await expect(renameImage(1, '一二三四五六七八九十一二三四五六')).rejects.toThrow('15')
    expect(await renameImage(1, '')).toBeNull()
    expect((await getImageDetail(1)).name).toBe('a.jpg')
  })

  it('加标签：别名和重复标签不占新位置，批量添加只跳过已有 15 个标签的图片', async () => {
    const byAlias = await addTag({ imageIds: [1], name: 'ganyu' })
    expect(byAlias).toMatchObject({ tag: { id: 1, name: '甘雨' }, added: 1, already: 0, skipped: 0 })
    const again = await addTag({ imageIds: [1, 2], name: '甘雨' })
    expect(again).toMatchObject({ added: 1, already: 1 })

    const catalog = await getTagCatalog()
    const theme = catalog.categories.find((c) => c.name === '主题')
    const created = await addTag({ imageIds: [1], name: '  表情  包 ' })
    expect(created.tag).toMatchObject({ name: '表情 包', categoryId: theme?.id })
    const place = catalog.categories.find((c) => c.name === '地点')
    expect((await addTag({ imageIds: [1], name: '京都', categoryId: place?.id })).tag.categoryId).toBe(place?.id)

    await addTag({ imageIds: [1], name: '四' })
    await addTag({ imageIds: [1], name: '五' })
    expect((await getImageDetail(1)).tags.map((t) => t.name)).toEqual(['甘雨', '表情 包', '京都', '四', '五'])
    for (let i = 6; i <= 15; i++) {
      expect(await addTag({ imageIds: [1], name: `标签${i}` })).toMatchObject({ added: 1, skipped: 0 })
    }
    expect(await addTag({ imageIds: [1], name: 'Ganyu' })).toMatchObject({ added: 0, already: 1 })
    expect(await addTag({ imageIds: [1, 3], name: '第十六个' })).toMatchObject({ added: 1, skipped: 1 })
    expect((await getImageDetail(1)).tags).toHaveLength(15)
    await expect(addTag({ imageIds: [1], name: '   ' })).rejects.toThrow('空')
    await expect(addTag({ imageIds: [1], name: 'x', categoryId: 999 })).rejects.toThrow('分类')

    const after = await getTagCatalog()
    expect(after.tags.find((t) => t.name === '甘雨')).toMatchObject({ aliases: ['Ganyu'], count: 2 })
  })

  it('移除标签，再加回来恢复', async () => {
    expect(await removeTag([1, 2], 1)).toBe(2)
    expect((await getImageDetail(2)).tags).toEqual([])
    await addTag({ imageIds: [2], name: '甘雨' })
    expect((await getImageDetail(2)).tags.map((t) => t.name)).toEqual(['甘雨'])
  })

  it('R-18：批量设置，R-18 图视图跟着变', async () => {
    expect(await setR18([2, 3], true)).toBe(2)
    expect((await listGallery({ view: 'r18', sort: 'new' })).items.map((i) => i.imageId).sort()).toEqual([2, 3])
    await setR18([3], false)
    expect((await listGallery({ view: 'r18', sort: 'new' })).items.map((i) => i.imageId)).toEqual([2])
    await expect(setR18([], true)).rejects.toThrow('没有选中')
  })

  it('筛选：标签（任一）、目录、还没打标签的目录项', async () => {
    const ids = async (q: Parameters<typeof listGallery>[0]): Promise<number[]> =>
      (await listGallery(q)).items.map((i) => i.imageId).sort((a, b) => a - b)
    // 前面从 1、2 号移除甘雨后只给 2 号加了回来
    expect(await ids({ view: 'all', sort: 'new', tagIds: [1] })).toEqual([2])
    await addTag({ imageIds: [7], name: '猫' })
    expect(await ids({ view: 'all', sort: 'new', dirs: [{ kind: 'category', name: '猫猫' }] })).toEqual([7])
    expect(await ids({ view: 'all', sort: 'new', dirs: [{ kind: 'source', id: 1 }] })).toEqual([1, 2, 3])
    expect(await listUntaggedDirs()).toEqual([{ dir: { kind: 'source', id: 1 }, label: 'pics', count: 3 }])
    await expect(listGallery({ view: 'all', sort: 'new', tagIds: [1, 2, 3, 4, 5, 6] })).rejects.toThrow('5')
  })

  it('计数在各表 id 对不上时也正确（子查询里引用外层列要带表名）', async () => {
    const { pg } = getDatabase()
    // 多插几条无关记录，让 image_file、image_tag 的 id 和 image 的 id 错开
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size) VALUES ('h8', 'JPG', 1), ('h9', 'JPG', 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (9, 1, 'i.jpg', now()), (8, 1, 'h.jpg', now());
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (9, 1, 'MANUAL', 'ACCEPTED');
    `)
    const ganyu = (await getTagCatalog()).tags.find((t) => t.name === '甘雨')
    expect(ganyu?.count).toBe(2)
    const ov = await (await import('../../src/main/services/libraryService')).getOverview(join(dir, 'library'))
    expect(ov.counts.total).toBe(9)
    expect(ov.counts.tagged).toBe(5)
  })

  it('更多筛选：组内“或”、组间“与”', () => {
    const base: GalleryItemVO = {
      imageId: 1, fileId: 1, name: 'x', format: 'JPG', width: 4000, height: 3000, byteSize: 2 * 1024 * 1024, hash: 'h',
      thumb: 'READY', missing: false, offline: false, isR18: false, tagged: true, importedAt: '2026-11-01T00:00:00Z', takenAt: '2026-11-10T00:00:00Z'
    }
    const now = new Date('2026-11-19T00:00:00Z')
    expect(matchMore(base, { fmt: ['PNG', 'JPG'], ori: ['h'] }, now)).toBe(true)
    expect(matchMore(base, { fmt: ['PNG'] }, now)).toBe(false)
    expect(matchMore(base, { res: ['4k'], size: ['m'], date: ['30d'] }, now)).toBe(true)
    expect(matchMore(base, { date: ['ly', 'none'] }, now)).toBe(false)
    expect(matchMore({ ...base, takenAt: null }, { date: ['none'] }, now)).toBe(true)
    expect(matchMore({ ...base, width: 900, height: 1600 }, { ori: ['v'], res: ['fhd'] }, now)).toBe(false)
  })
})
