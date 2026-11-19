import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { getImageDetail, listGallery } from '../../src/main/services/galleryService'
import { configureFileOps } from '../../src/main/services/fileOps/fileOpsService'
import {
  configureFolderOps,
  createFolder,
  deleteCategoryFolder,
  removeSource,
  renameCategoryFolder
} from '../../src/main/services/fileOps/folderOpsService'
import { dirChildren } from '../../src/main/services/folderService'
import { getOverview } from '../../src/main/services/libraryService'
import { updateSettings } from '../../src/main/services/settingsService'

let dir: string
let source: string
let library: string
let bin: string

const ids = async (q: Parameters<typeof listGallery>[0]): Promise<number[]> =>
  (await listGallery(q)).items.map((i) => i.imageId).sort((a, b) => a - b)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-folders-'))
  source = join(dir, 'pics')
  library = join(dir, 'library')
  bin = join(dir, 'bin')
  mkdirSync(join(source, 'a', 'deep'), { recursive: true })
  mkdirSync(join(source, 'b'), { recursive: true })
  mkdirSync(join(library, '壁纸', '横屏'), { recursive: true })
  mkdirSync(bin)
  for (const f of ['top.jpg', 'a\\x.jpg', 'a\\deep\\y.jpg', 'b\\z.jpg']) {
    writeFileSync(join(source, f), f)
  }
  writeFileSync(join(library, '壁纸', '横屏', 'w.jpg'), 'w')
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  await updateSettings({ categoryHome: library })
  const { pg } = getDatabase()
  await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1), ('CATEGORY', '类目录', $2)`, [source, library])
  await pg.exec(`
    INSERT INTO image (content_hash, format, byte_size) VALUES ('h1', 'JPG', 1), ('h2', 'JPG', 1), ('h3', 'JPG', 1), ('h4', 'JPG', 1), ('h5', 'JPG', 1);
    INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
      (1, 1, 'top.jpg', now()), (2, 1, 'a\\x.jpg', now()), (3, 1, 'a\\deep\\y.jpg', now()), (4, 1, 'b\\z.jpg', now()), (5, 2, '壁纸\\横屏\\w.jpg', now());
  `)
  configureFolderOps(library)
  configureFileOps({ trash: async (p) => renameSync(p, join(bin, `${Date.now()}`)), onDone: () => undefined })
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('目录管理', () => {
  it('子文件夹视图：含子目录 / 仅当前目录；类目录可以带子路径', async () => {
    expect(await ids({ view: 'source', sourceId: 1, sub: 'a', sort: 'new' })).toEqual([2, 3])
    expect(await ids({ view: 'source', sourceId: 1, sub: 'a', onlyHere: true, sort: 'new' })).toEqual([2])
    expect(await ids({ view: 'category', category: '壁纸\\横屏', sort: 'new' })).toEqual([5])
    await expect(listGallery({ view: 'source', sourceId: 1, sub: '..\\..', sort: 'new' })).rejects.toThrow('路径不对')
  })

  it('目录树展开一层：磁盘上的子文件夹和各自的图片数', async () => {
    expect(await dirChildren({ kind: 'source', id: 1, sub: '' })).toEqual([
      { name: 'a', rel: 'a', count: 2, hasChildren: true },
      { name: 'b', rel: 'b', count: 1, hasChildren: false }
    ])
    expect(await dirChildren({ kind: 'category', path: '壁纸' })).toEqual([{ name: '横屏', rel: '壁纸\\横屏', count: 1, hasChildren: false }])
  })

  it('新建目录：默认名、同级重名加编号、名字校验', async () => {
    expect(await createFolder({ kind: 'category', path: '' }, null)).toBe('未命名的类目录')
    expect(await createFolder({ kind: 'category', path: '' }, '')).toBe('未命名的类目录 2')
    expect(await createFolder({ kind: 'category', path: '壁纸' }, null)).toBe('壁纸\\未命名的子目录')
    expect(await createFolder({ kind: 'source', id: 1, sub: 'b' }, null)).toBe('b\\新建文件夹')
    expect(existsSync(join(source, 'b', '新建文件夹'))).toBe(true)
    await expect(createFolder({ kind: 'category', path: '' }, 'a/b')).rejects.toThrow('字符')
    await expect(createFolder({ kind: 'category', path: '' }, '一二三四五六七八九十一二三四五六')).rejects.toThrow('15')
    expect((await getOverview(library)).categories.map((c) => c.name).sort()).toEqual(['未命名的类目录', '未命名的类目录 2', '壁纸'].sort())
  })

  it('类目录改名：磁盘改名，下面的记录路径跟着换；和兄弟重名拒绝', async () => {
    expect(await renameCategoryFolder({ kind: 'category', path: '壁纸' }, '壁纸精选')).toBe('壁纸精选')
    expect(existsSync(join(library, '壁纸精选', '横屏', 'w.jpg'))).toBe(true)
    expect((await getImageDetail(5)).locations[0].path).toBe(join(library, '壁纸精选', '横屏', 'w.jpg'))
    expect(await ids({ view: 'category', category: '壁纸精选', sort: 'new' })).toEqual([5])
    await expect(renameCategoryFolder({ kind: 'category', path: '壁纸精选' }, '未命名的类目录')).rejects.toThrow('已经有')
    await expect(renameCategoryFolder({ kind: 'source', id: 1, sub: 'a' }, 'q')).rejects.toThrow('只能给类目录')
  })

  it('删除类目录：整个文件夹进回收站，里面的副本记录去掉', async () => {
    expect(await deleteCategoryFolder({ kind: 'category', path: '壁纸精选' })).toBe(1)
    expect(existsSync(join(library, '壁纸精选'))).toBe(false)
    expect(readdirSync(bin)).toHaveLength(1)
    expect(await ids({ view: 'recent', sort: 'new' })).not.toContain(5)
  })

  it('从图库移除源目录：记录去掉，磁盘文件不动', async () => {
    await removeSource(1)
    expect((await getOverview(library)).sources).toEqual([])
    expect(existsSync(join(source, 'top.jpg'))).toBe(true)
    expect(await ids({ view: 'recent', sort: 'new' })).toEqual([])
  })
})
