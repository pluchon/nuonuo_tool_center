import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'

// 出方案的模型调用换成脚本
let planReply = ''
const prompts: string[] = []
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async (input: { messages: Array<{ content: string }> }) => {
    prompts.push(input.messages[0].content)
    return { message: { role: 'assistant', content: planReply }, finishReason: 'stop', usage: {} }
  }),
  searchCall: vi.fn(),
  getBailianClient: vi.fn(),
  recordBatchUsage: vi.fn()
}))
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))

const org = await import('../../src/main/services/ai/organizeService')
const sugg = await import('../../src/main/services/ai/suggestionService')
const { listGallery } = await import('../../src/main/services/galleryService')
const { configureFolderOps } = await import('../../src/main/services/fileOps/folderOpsService')
const { configureTransfer } = await import('../../src/main/services/fileOps/transferService')
const { configureFileOps } = await import('../../src/main/services/fileOps/fileOpsService')
const { updateSettings } = await import('../../src/main/services/settingsService')

describe('方案整理和本地分图（纯函数）', () => {
  it('名字不合法、词不在给的范围里、重复的词和没词的目录都去掉；沿用现有目录不分大小写', () => {
    const allowed = new Set(['甘雨', '原神', '表情包', '猫'])
    const plan = org.sanitizePlan(
      {
        folders: [
          { name: 'genshin', works: ['原神(12)'], characters: ['甘雨', '不存在的'] },
          { name: '表情/包', tags: ['表情包'] },
          { name: '猫猫', tags: ['猫', '甘雨'] },
          { name: '空的', tags: ['不存在的'] },
          { name: 'Genshin', tags: ['表情包'] }
        ]
      },
      allowed,
      ['Genshin']
    )
    expect(plan).toEqual([
      { name: 'Genshin', isNew: false, characters: ['甘雨'], works: ['原神'], tags: [] },
      { name: '猫猫', isNew: true, characters: [], works: [], tags: ['猫'] }
    ])
    expect(org.sanitizePlan(null, allowed, [])).toEqual([])
  })

  it('分图：角色优先，其次作品，再次标签；对不上的不分', () => {
    const plan = [
      { name: '表情包', isNew: true, characters: [], works: [], tags: ['表情包'] },
      { name: '原神', isNew: true, characters: [], works: ['原神'], tags: [] },
      { name: '甘雨', isNew: true, characters: ['甘雨'], works: [], tags: [] }
    ]
    const rows = org.assignFolders(
      [
        { imageId: 1, characters: ['甘雨'], works: ['原神'], tags: ['表情包'] },
        { imageId: 2, characters: [], works: ['原神'], tags: ['表情包'] },
        { imageId: 3, characters: [], works: [], tags: ['表情包'] },
        { imageId: 4, characters: [], works: [], tags: ['风景'] }
      ],
      plan
    )
    expect(rows).toEqual([
      { imageId: 1, dir: '甘雨' },
      { imageId: 2, dir: '原神' },
      { imageId: 3, dir: '表情包' }
    ])
  })
})

describe('一键整理：出方案 → 批方案 → 建议 → 采用', () => {
  let dir: string
  let library: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-organize-'))
    const source = join(dir, 'pics')
    library = join(dir, 'library')
    mkdirSync(source)
    mkdirSync(join(library, '风景'), { recursive: true })
    for (const f of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']) {
      writeFileSync(join(source, f), f)
    }
    writeFileSync(join(library, '风景', 'e.jpg'), 'e.jpg')
    process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    await updateSettings({ categoryHome: library })
    configureFolderOps(library)
    configureTransfer(library)
    configureFileOps({ trash: async (p) => renameSync(p, join(dir, `bin-${Date.now()}`)), onDone: () => undefined })
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1), ('CATEGORY', 'library', $2)`, [source, library])
    // 1 甘雨（已打标签）；2 待确认建议里是原神；3 R-18；4 什么词都没有；5 已经在类目录“风景”里
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, rating, rating_source, is_r18) VALUES
        ('h1', 'JPG', 1, 'GENERAL', 'MODEL', false), ('h2', 'JPG', 1, 'GENERAL', 'MODEL', false),
        ('h3', 'JPG', 1, 'EXPLICIT', 'MODEL', true), ('h4', 'JPG', 1, 'GENERAL', 'MANUAL', false), ('h5', 'JPG', 1, 'GENERAL', 'MODEL', false);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
        (1, 1, 'a.jpg', now()), (2, 1, 'b.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.jpg', now()), (5, 2, '风景\\e.jpg', now());
      INSERT INTO tag (name, category_id) SELECT '甘雨', id FROM tag_category WHERE name = '角色';
      INSERT INTO tag (name, category_id) SELECT '风景', id FROM tag_category WHERE name = '主题';
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (1, 1, 'MANUAL', 'ACCEPTED'), (3, 1, 'MANUAL', 'ACCEPTED'), (5, 2, 'MANUAL', 'ACCEPTED');
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status) VALUES
        (2, 'IDENTIFY', 'm', '{"name":"","character":"","work":"原神","tags":[],"source":"","description":""}', '{"work":"PENDING"}');
      INSERT INTO ai_job (kind, image_id, status) VALUES ('LOOK', 2, 'DONE');
    `)
    org.configureOrganize({ onState: () => undefined, onSuggested: () => undefined })
  })
  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  it('估算只算还没看过、没打标签、过了闸门的图；本地分级没做完时不能开始', async () => {
    expect(await org.estimateOrganize()).toMatchObject({ toLook: 1, ratingLeft: 0 })
    const { pg } = getDatabase()
    await pg.exec(`INSERT INTO image (content_hash, format, byte_size, thumb_ready) VALUES ('h6', 'JPG', 1, 1)`)
    expect(await org.estimateOrganize()).toMatchObject({ ratingLeft: 1 })
    await expect(org.startOrganize()).rejects.toThrow('本地分级还剩 1 张')
    await pg.exec(`UPDATE image SET rating = 'EXPLICIT', rating_source = 'MODEL', is_r18 = true WHERE content_hash = 'h6'`)
  })

  it('看图排队后出方案：只把非 R-18、不在类目录里的图的词交给模型', async () => {
    planReply = '```json\n{"folders":[{"name":"原神","works":["原神"],"characters":["甘雨"]},{"name":"风景","tags":["风景"]}]}\n```'
    const s = await org.startOrganize()
    expect(s.phase).toBe('LOOKING')
    // 图 4 排进了看图队列：标成看完，再检查一次就出方案
    const { pg } = getDatabase()
    await pg.exec(`UPDATE ai_job SET status = 'DONE' WHERE kind = 'LOOK'`)
    await org.checkLooking()
    await vi.waitFor(() => expect(org.getOrganizeState().phase).toBe('PLAN_READY'))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('甘雨(1)')
    expect(prompts[0]).toContain('原神(1)')
    expect(prompts[0]).toContain('- 风景')
    // 风景这个词只在已经在类目录里的图上：不给模型，方案里的“风景”目录没有词被去掉
    expect(org.getOrganizeState().plan).toEqual([{ name: '原神', isNew: true, characters: ['甘雨'], works: ['原神'], tags: [] }])
  })

  it('批方案后生成“放进类目录”的建议；AI 建议视图按目录分组、标出新建', async () => {
    const plan = org.getOrganizeState().plan!
    expect(await org.approveOrganize([{ ...plan[0], name: '原神图' }])).toBe(2)
    expect(org.getOrganizeState().phase).toBe('IDLE')
    const list = await sugg.listSuggestions(1)
    expect(list).toEqual([{ key: 'dir', kind: 'dir', value: '原神图', origin: 'NONO', isNew: true }])
    const view = await listGallery({ view: 'ai', sort: 'name' })
    expect(view.items.map((i) => [i.imageId, i.aiDir])).toEqual([
      [2, { name: '原神图', isNew: true }],
      [1, { name: '原神图', isNew: true }]
    ])
    // 再批一次不会重复生成
    await expect(org.approveOrganize(plan)).rejects.toThrow('没有待确认的方案')
  })

  it('一起采用：目录不在就建，复制进去（原图不动），建议处理完离开视图；不要的标成拒绝', async () => {
    const res = await sugg.decideMany([1, 2], true)
    expect(res).toEqual({ done: 2, failed: 0, error: null })
    expect(existsSync(join(library, '原神图', 'a.jpg'))).toBe(true)
    expect(existsSync(join(library, '原神图', 'b.jpg'))).toBe(true)
    expect(existsSync(join(dir, 'pics', 'a.jpg'))).toBe(true)
    expect((await listGallery({ view: 'ai', sort: 'new' })).items).toEqual([])
    // 图 2 的“原神”建议也一起采用成了标签
    const { pg } = getDatabase()
    const tags = await pg.query<{ name: string }>(`SELECT t.name FROM image_tag it JOIN tag t ON t.id = it.tag_id WHERE it.image_id = 2 AND it.delete_state = 0`)
    expect(tags.rows.map((r) => r.name)).toEqual(['原神'])
    await expect(sugg.decideMany([], true)).rejects.toThrow('一次最多')
  })
})
