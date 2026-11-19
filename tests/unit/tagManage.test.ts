import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { getImageDetail } from '../../src/main/services/galleryService'
import { addTag, getTagCatalog } from '../../src/main/services/imageEditService'
import {
  createCategory,
  createTag,
  deleteTag,
  removeCategory,
  renameCategory,
  saveTag,
  setCategoryColor
} from '../../src/main/services/tagManageService'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-tagmanage-'))
  const source = join(dir, 'pics')
  mkdirSync(source, { recursive: true })
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  const { pg } = getDatabase()
  await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
  await pg.exec(`
    INSERT INTO image (content_hash, format, byte_size) VALUES ('h1', 'JPG', 1), ('h2', 'JPG', 1), ('h3', 'JPG', 1), ('h4', 'JPG', 1);
    INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, 'a.jpg', now()), (2, 1, 'b.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.jpg', now());
  `)
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

// 按名字取标签
async function tagNamed(name: string) {
  return (await getTagCatalog()).tags.find((t) => t.name === name)
}

async function categoryNamed(name: string) {
  return (await getTagCatalog()).categories.find((c) => c.name === name)
}

describe('标签管理', () => {
  it('新建标签：带别名；名字或别名和已有的撞上时拒绝', async () => {
    const role = await categoryNamed('角色')
    const id = await createTag({ name: ' 甘雨 ', categoryId: role!.id, aliases: ['ganyu', '椰羊', 'GANYU', '甘雨'] })
    expect(await tagNamed('甘雨')).toMatchObject({ id, categoryId: role!.id, aliases: ['ganyu', '椰羊'], count: 0 })
    await expect(createTag({ name: 'Ganyu', categoryId: role!.id, aliases: [] })).rejects.toThrow('别名')
    await expect(createTag({ name: '甘雨', categoryId: role!.id, aliases: [] })).rejects.toThrow('已经有标签')
    await expect(createTag({ name: '刻晴', categoryId: role!.id, aliases: ['椰羊'] })).rejects.toThrow('椰羊')
    await expect(createTag({ name: '一二三四五六七八九十一二三四五六', categoryId: role!.id, aliases: [] })).rejects.toThrow('15')
    await expect(createTag({ name: '刻晴', categoryId: 999, aliases: [] })).rejects.toThrow('分类')
  })

  it('保存：改名、换分类、别名整组替换', async () => {
    const work = await categoryNamed('作品')
    const ganyu = (await tagNamed('甘雨'))!
    await addTag({ imageIds: [1, 2], name: '甘雨' })
    expect(await saveTag({ id: ganyu.id, name: '甘雨酱', categoryId: work!.id, aliases: ['椰羊', 'Ganyu Chan'] })).toBe(ganyu.id)
    expect(await tagNamed('甘雨酱')).toMatchObject({ categoryId: work!.id, aliases: ['椰羊', 'Ganyu Chan'], count: 2 })
    expect((await getImageDetail(1)).tags.map((t) => t.name)).toEqual(['甘雨酱'])
    // 原来的别名 ganyu 删掉了，可以给别的标签用
    await createTag({ name: '刻晴', categoryId: work!.id, aliases: ['ganyu'] })
    await expect(saveTag({ id: ganyu.id, name: '刻晴', categoryId: work!.id, aliases: [] })).rejects.toThrow('已经有标签')
  })

  it('合并进来：来源的图改挂过来，名字和别名变成别名，来源删掉；同一张图不重复', async () => {
    await addTag({ imageIds: [2, 3], name: '原神' })
    await addTag({ imageIds: [3, 4], name: 'Genshin' })
    const yuanshen = (await tagNamed('原神'))!
    const genshin = (await tagNamed('Genshin'))!
    const keqing = (await tagNamed('刻晴'))!
    await addTag({ imageIds: [4], name: '刻晴' })
    const id = await saveTag({ id: yuanshen.id, name: '原神', categoryId: yuanshen.categoryId, aliases: [], mergeFrom: [genshin.id, keqing.id] })
    expect(id).toBe(yuanshen.id)
    const after = (await tagNamed('原神'))!
    expect(after.count).toBe(3)
    expect(after.aliases.sort()).toEqual(['Genshin', 'ganyu', '刻晴'].sort())
    expect(await tagNamed('Genshin')).toBeUndefined()
    expect((await getImageDetail(4)).tags.map((t) => t.name)).toEqual(['原神'])
    expect((await getImageDetail(3)).tags.map((t) => t.name)).toEqual(['原神'])
    await expect(saveTag({ id: yuanshen.id, name: '原神', categoryId: yuanshen.categoryId, aliases: [], mergeFrom: [101, 102, 103, 104, 105, 106] })).rejects.toThrow('5')
  })

  it('并入其他标签：这个标签的图挂到目标上，自己消失', async () => {
    const ganyu = (await tagNamed('甘雨酱'))!
    const yuanshen = (await tagNamed('原神'))!
    const id = await saveTag({ id: ganyu.id, name: '甘雨酱', categoryId: ganyu.categoryId, aliases: ganyu.aliases, mergeInto: yuanshen.id })
    expect(id).toBe(yuanshen.id)
    expect(await tagNamed('甘雨酱')).toBeUndefined()
    const after = (await tagNamed('原神'))!
    expect(after.count).toBe(4)
    expect(after.aliases).toEqual(expect.arrayContaining(['甘雨酱', '椰羊', 'Ganyu Chan']))
    expect((await getImageDetail(1)).tags.map((t) => t.name)).toEqual(['原神'])
  })

  it('删除标签：从图上去掉，返回受影响的张数', async () => {
    const yuanshen = (await tagNamed('原神'))!
    expect(await deleteTag(yuanshen.id)).toBe(4)
    expect(await tagNamed('原神')).toBeUndefined()
    expect((await getImageDetail(1)).tags).toEqual([])
    await expect(deleteTag(yuanshen.id)).rejects.toThrow('不在')
    // 名字和别名都释放了
    await createTag({ name: '原神', categoryId: yuanshen.categoryId, aliases: ['椰羊'] })
  })

  it('分类：新增（重名编号、不撞色）、改名、换色、删除限制', async () => {
    const a = await createCategory()
    const b = await createCategory()
    expect([a.name, b.name]).toEqual(['新分类', '新分类 2'])
    const before = (await getTagCatalog()).categories
    expect(new Set(before.map((c) => c.colorIndex)).size).toBe(before.length)
    expect(await renameCategory(a.id, ' 游戏 ')).toBe('游戏')
    await expect(renameCategory(b.id, '游戏')).rejects.toThrow('已经有分类')
    await expect(renameCategory(b.id, '一二三四五六七')).rejects.toThrow('6')
    await setCategoryColor(a.id, 0)
    expect((await categoryNamed('游戏'))!.colorIndex).toBe(0)
    await expect(setCategoryColor(a.id, 12)).rejects.toThrow('颜色')
    await createTag({ name: '塞尔达', categoryId: a.id, aliases: [] })
    await expect(removeCategory(a.id)).rejects.toThrow('还有标签')
    await removeCategory(b.id)
    expect(await categoryNamed('新分类 2')).toBeUndefined()
  })
})
