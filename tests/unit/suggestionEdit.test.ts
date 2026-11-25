import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NAME_MAX, TAG_NAME_MAX } from '@shared/api'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { configureFolderOps } from '../../src/main/services/fileOps/folderOpsService'
import { invalidateCategoryTree } from '../../src/main/services/fileOps/categoryPaths'
import { hashFile } from '../../src/main/services/scan/imageProbe'

vi.mock('electron', () => ({
  clipboard: {},
  ClipboardItem: class {},
  nativeImage: {},
  shell: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'test',
    encryptStringAsync: async () => Buffer.from('仅用于测试')
  }
}))

const sugg = await import('../../src/main/services/ai/suggestionService')

describe('AI 建议行内修改后采用', () => {
  let dir: string
  let sourceDir: string
  let categoryDir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-sugg-edit-'))
    sourceDir = join(dir, 'source')
    categoryDir = join(dir, 'category')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(categoryDir, { recursive: true })
    configureFolderOps(categoryDir)
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'src', $1)`, [sourceDir])
  })

  afterAll(async () => {
    configureFolderOps(null)
    invalidateCategoryTree()
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    const { pg } = getDatabase()
    invalidateCategoryTree()
    await pg.exec(`
      TRUNCATE ai_event, image_ai_result, image_tag, image_file, image RESTART IDENTITY CASCADE;
      DELETE FROM tag;
    `)
    // 清空类目录下测试生成的文件夹
    for (const name of ['原目录', '新目录', '插画', '原神', '二次元']) {
      rmSync(join(categoryDir, name), { recursive: true, force: true })
    }
    const picPath = join(sourceDir, 'pic.jpg')
    writeFileSync(picPath, 'fake-image')
    const hash = await hashFile(picPath)
    await pg.query(
      `INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18)
       VALUES ($1, 'JPG', 10, 800, 600, 1, 'GENERAL', 'MODEL', false)`,
      [hash]
    )
    await pg.exec(`
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
      VALUES (1, 1, 'pic.jpg', now());
    `)
  })

  it('逐项行内修改 name / tag / who / work / src / dir 后采用，并记录 edited 与 originalValue', async () => {
    const { pg } = getDatabase()
    mkdirSync(join(categoryDir, '插画', '原神'), { recursive: true })
    await pg.exec(`
      INSERT INTO image_ai_result (image_id, kind, origin, model, result, field_status) VALUES
        (1, 'IDENTIFY', 'NONO', 'test', '{"name":"原名","character":"原角色","work":"原作品","tags":["原标签"],"source":"https://old.example.com/1","description":""}', '{"name":"PENDING","tag:原标签":"PENDING","who":"PENDING","work":"PENDING","src":"PENDING"}'),
        (1, 'ORGANIZE', 'NONO', 'test', '{"dir":"原目录","existing":false}', '{"dir":"PENDING"}');
    `)

    await sugg.decideSuggestion(1, 'name', true, '  新名字  ')
    await sugg.decideSuggestion(1, 'tag:原标签', true, '  新标签  ')
    await sugg.decideSuggestion(1, 'who', true, '甘雨')
    await sugg.decideSuggestion(1, 'work', true, '原神')
    await sugg.decideSuggestion(1, 'src', true, '  https://www.pixiv.net/artworks/999  ')
    const left = await sugg.decideSuggestion(1, 'dir', true, '插画/原神')

    expect(left).toEqual([])
    expect(existsSync(join(categoryDir, '插画', '原神', 'pic.jpg'))).toBe(true)
    const img = (await pg.query<{ display_name: string; source: string }>('SELECT display_name, source FROM image WHERE id = 1')).rows[0]
    expect(img).toEqual({ display_name: '新名字', source: 'https://www.pixiv.net/artworks/999' })

    const tags = (
      await pg.query<{ name: string; cat: string }>(
        `SELECT t.name, c.name AS cat
         FROM image_tag it
         JOIN tag t ON t.id = it.tag_id
         JOIN tag_category c ON c.id = t.category_id
         WHERE it.image_id = 1 AND it.status = 'ACCEPTED'
         ORDER BY c.id, t.name`
      )
    ).rows
    expect(tags).toEqual([
      { name: '甘雨', cat: '角色' },
      { name: '原神', cat: '作品' },
      { name: '新标签', cat: '主题' }
    ])
  })

  it('行内修改 dir（已有子目录用正斜杠或新建单级目录）与 ai_event 记录', async () => {
    const { pg } = getDatabase()
    mkdirSync(join(categoryDir, '插画', '原神'), { recursive: true })
    await pg.exec(`
      INSERT INTO image_ai_result (image_id, kind, origin, model, result, field_status) VALUES
        (1, 'IDENTIFY', 'NONO', 'test', '{"name":"原名","character":"","work":"","tags":[],"source":"","description":""}', '{"name":"PENDING"}'),
        (1, 'ORGANIZE', 'NONO', 'test', '{"dir":"原目录","existing":true}', '{"dir":"PENDING"}');
    `)

    await sugg.decideSuggestion(1, 'name', true, '原名')
    const left = await sugg.decideSuggestion(1, 'dir', true, '插画/原神')
    expect(left).toEqual([])
    expect(existsSync(join(categoryDir, '插画', '原神', 'pic.jpg'))).toBe(true)

    const events = (
      await pg.query<{ kind: string; payload: Record<string, unknown> }>(
        `SELECT kind, payload FROM ai_event WHERE kind = 'suggestion.accept' ORDER BY id`
      )
    ).rows
    expect(events).toHaveLength(2)
    // 未修改内容不记 edited / originalValue
    expect(events[0].payload).toEqual({ kind: 'name', value: '原名', origin: 'NONO' })
    // 修改后记 edited 与 originalValue
    expect(events[1].payload).toEqual({
      kind: 'dir',
      value: '插画\\原神',
      origin: 'NONO',
      originalValue: '原目录',
      edited: true
    })
  })

  it('已有目录建议修改为新的单级目录名时也能顺利新建并采用', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image_ai_result (image_id, kind, origin, model, result, field_status) VALUES
        (1, 'ORGANIZE', 'NONO', 'test', '{"dir":"原目录","existing":true}', '{"dir":"PENDING"}');
    `)
    const left = await sugg.decideSuggestion(1, 'dir', true, '新目录')
    expect(left).toEqual([])
    expect(existsSync(join(categoryDir, '新目录', 'pic.jpg'))).toBe(true)
  })

  it('acceptAllSuggestions 支持部分字段 overrides，并在失败时预先校验不污染数据库', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image_ai_result (image_id, kind, origin, model, result, field_status) VALUES
        (1, 'IDENTIFY', 'NONO', 'test', '{"name":"AI名","character":"AI角","work":"AI作","tags":["AI标"],"source":"https://a.example.com","description":""}', '{"name":"PENDING","tag:AI标":"PENDING","who":"PENDING","work":"PENDING","src":"PENDING"}');
    `)

    // 其中一项校验失败时，所有字段都应保持 PENDING 且不写任何数据
    await expect(sugg.acceptAllSuggestions(1, { name: '改后名', src: 'not-a-url' })).rejects.toThrow('http')
    expect((await sugg.listSuggestions(1)).map((s) => s.key)).toEqual(['name', 'tag:AI标', 'who', 'work', 'src'])
    expect((await pg.query<{ display_name: string | null }>('SELECT display_name FROM image WHERE id = 1')).rows[0].display_name).toBeNull()
    expect((await pg.query('SELECT id FROM ai_event')).rows).toHaveLength(0)

    // 全部合法时一次性采用，部分修改项带 edited + originalValue
    const left = await sugg.acceptAllSuggestions(1, {
      name: '最终名字',
      'tag:AI标': '最终标签',
      src: 'https://b.example.com/ok'
    })
    expect(left).toEqual([])

    const img = (await pg.query<{ display_name: string; source: string }>('SELECT display_name, source FROM image WHERE id = 1')).rows[0]
    expect(img).toEqual({ display_name: '最终名字', source: 'https://b.example.com/ok' })

    const events = (await pg.query<{ payload: Record<string, unknown> }>('SELECT payload FROM ai_event ORDER BY id')).rows.map((r) => r.payload)
    expect(events.find((e) => e.kind === 'name')).toEqual({
      kind: 'name',
      value: '最终名字',
      origin: 'NONO',
      originalValue: 'AI名',
      edited: true
    })
    expect(events.find((e) => e.kind === 'tag')).toEqual({
      kind: 'tag',
      value: '最终标签',
      origin: 'NONO',
      originalValue: 'AI标',
      edited: true
    })
    expect(events.find((e) => e.kind === 'who')).toEqual({
      kind: 'who',
      value: 'AI角',
      origin: 'NONO'
    })
  })

  it('各种非法输入都会被拦截并保持建议状态不变', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image_ai_result (image_id, kind, origin, model, result, field_status) VALUES
        (1, 'IDENTIFY', 'NONO', 'test', '{"name":"原名","character":"原角色","work":"原作品","tags":["原标签"],"source":"https://old.example.com/1","description":""}', '{"name":"PENDING","tag:原标签":"PENDING","who":"PENDING","work":"PENDING","src":"PENDING"}'),
        (1, 'ORGANIZE', 'NONO', 'test', '{"dir":"原目录","existing":false}', '{"dir":"PENDING"}');
    `)

    await expect(sugg.decideSuggestion(1, 'name', true, '   ')).rejects.toThrow('不能为空')
    await expect(sugg.decideSuggestion(1, 'name', true, '字'.repeat(NAME_MAX + 1))).rejects.toThrow(`${NAME_MAX}`)
    await expect(sugg.decideSuggestion(1, 'tag:原标签', true, '')).rejects.toThrow('不能为空')
    await expect(sugg.decideSuggestion(1, 'who', true, '角'.repeat(TAG_NAME_MAX + 1))).rejects.toThrow(`${TAG_NAME_MAX}`)
    await expect(sugg.decideSuggestion(1, 'src', true, 'ftp://example.com/1')).rejects.toThrow('http')
    await expect(sugg.decideSuggestion(1, 'dir', true, '../escape')).rejects.toThrow('目录路径格式不对')
    await expect(sugg.decideSuggestion(1, 'dir', true, '   ')).rejects.toThrow('目录路径格式不对')
    await expect(sugg.decideSuggestion(1, 'dir', true, '.hidden')).rejects.toThrow('目录路径格式不对')

    // 全都还留在待确认列表里
    expect(await sugg.listSuggestions(1)).toHaveLength(6)
    expect((await pg.query('SELECT id FROM ai_event')).rows).toHaveLength(0)
  })
})
