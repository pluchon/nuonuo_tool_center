import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { hashBuffer } from '../../src/main/services/scan/imageProbe'

// 出方案的模型调用换成脚本
let planReply = ''
const prompts: string[] = []
let planGate: Promise<void> | undefined
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async (input: { messages: Array<{ content: string }> }) => {
    prompts.push(input.messages[0].content)
    await planGate
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
const { insertOrganizeResults } = await import('../../src/main/repositories/aiResultRepository')
const { upsertSettings } = await import('../../src/main/repositories/appSettingRepository')

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
    configureFolderOps(library)
    configureTransfer(library)
    configureFileOps({ trash: async (p) => renameSync(p, join(dir, `bin-${Date.now()}`)), onDone: () => undefined })
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1), ('CATEGORY', 'library', $2)`, [source, library])
    // 1 甘雨（已打标签）；2 待确认建议里是原神；3 R-18；4 什么词都没有；5 已经在类目录“风景”里
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, rating, rating_source, is_r18) VALUES
        ('${hashBuffer(Buffer.from('a.jpg'))}', 'JPG', 5, 'GENERAL', 'MODEL', false), ('${hashBuffer(Buffer.from('b.jpg'))}', 'JPG', 5, 'GENERAL', 'MODEL', false),
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

  it('估算只算还没看过、没打标签、过了闸门的图；还报本地分级还剩几张', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    try {
      await expect(org.startOrganize()).rejects.toMatchObject({ code: 'DEPENDENCY_FAILED', message: '请在「设置 → AI」中配置百炼 API Key' })
      expect(org.getOrganizeState().phase).toBe('IDLE')
    } finally {
      vi.unstubAllEnvs()
    }
    const before = await org.estimateOrganize()
    expect(before).toMatchObject({ toLook: 1, ratingLeft: 0 })
    const { pg } = getDatabase()
    await pg.exec(`INSERT INTO image (content_hash, format, byte_size, thumb_ready) VALUES ('h6', 'JPG', 1, 1)`)
    const after = await org.estimateOrganize()
    expect(after).toMatchObject({ toLook: 1, ratingLeft: 1 })
    expect(after.tokens).toBeGreaterThan(before.tokens)
    await pg.exec(`UPDATE image SET rating = 'EXPLICIT', rating_source = 'MODEL', is_r18 = true WHERE content_hash = 'h6'`)
  })

  it('关闭估算后停止读取下一批图片', async () => {
    const { pg, db } = getDatabase()
    const controller = new AbortController()
    await pg.exec("insert into image (content_hash, format, byte_size) select 'cancel-estimate-' || i, 'JPG', 1 from generate_series(1, 600) i")
    const execute = vi.spyOn(db, 'execute')
    try {
      const estimate = org.estimateOrganize(controller.signal)
      setImmediate(() => controller.abort())
      await expect(estimate).rejects.toMatchObject({ name: 'AbortError' })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      execute.mockRestore()
      await pg.exec("delete from image where content_hash like 'cancel-estimate-%'")
    }
  })

  it('看图排队后出方案：只把非 R-18、不在类目录里的图的词交给模型', async () => {
    planReply = '```json\n{"folders":[{"name":"原神","works":["原神"],"characters":["甘雨"]},{"name":"风景","tags":["风景"]}]}\n```'
    const s = await org.startOrganize()
    expect(s.phase).toBe('LOOKING')
    // 按钮上的进度：这次排进 1 张、还没看完（之前看完的图 2 不算）
    expect(s.looked).toEqual({ done: 0, total: 1 })
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

  it('同一张图建议过同一个目录（还没处理、采用过、说过不要）就不再建议；换个目录还能建议', async () => {
    const { pg } = getDatabase()
    expect(await insertOrganizeResults([{ imageId: 4, dir: '猫猫' }], 'm')).toBe(1)
    expect(await insertOrganizeResults([{ imageId: 4, dir: '猫猫' }], 'm')).toBe(0)
    await pg.exec(`UPDATE image_ai_result SET field_status = '{"dir":"REJECTED"}' WHERE image_id = 4 AND kind = 'ORGANIZE'`)
    expect(await insertOrganizeResults([{ imageId: 4, dir: '猫猫' }], 'm')).toBe(0)
    expect(await insertOrganizeResults([{ imageId: 4, dir: '猫咪' }], 'm')).toBe(1)
    await pg.exec(`DELETE FROM image_ai_result WHERE image_id = 4 AND kind = 'ORGANIZE'`)
  })

  it('本地分级没判完不能开始；开始后新导入的图进入补图：判完排进批量看图、看完按方案分，都做完自己收尾', async () => {
    const { resetOrganizeRules } = await import('../../src/main/services/ai/aiPolicy')
    await resetOrganizeRules()
    const { pg } = getDatabase()
    // 7 还没分级：不能开始
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, thumb_ready) VALUES ('h7', 'JPG', 1, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT id, 1, content_hash || '.jpg', now() FROM image WHERE content_hash = 'h7';
    `)
    const id7 = Number((await pg.query<{ id: number }>(`SELECT id FROM image WHERE content_hash = 'h7'`)).rows[0].id)
    await expect(org.startOrganize()).rejects.toThrow('本地分级还剩 1 张，判完才能整理')
    expect(org.getOrganizeState().phase).toBe('IDLE')
    // 先当它判完了，开始整理；8 已经看过（待确认里有“原神”）
    await pg.query(`UPDATE image SET rating = 'GENERAL', rating_source = 'MODEL' WHERE id = $1`, [id7])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, thumb_ready, rating, rating_source) VALUES ('h8', 'JPG', 1, 1, 'GENERAL', 'MODEL');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT id, 1, content_hash || '.jpg', now() FROM image WHERE content_hash = 'h8';
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
        SELECT id, 'IDENTIFY', 'm', '{"name":"","character":"","work":"原神","tags":[],"source":"","description":""}', '{"work":"PENDING"}' FROM image WHERE content_hash = 'h8';
      INSERT INTO ai_job (kind, image_id, status) SELECT 'LOOK', id, 'DONE' FROM image WHERE content_hash = 'h8';
      INSERT INTO ai_job (kind, image_id, status) VALUES ('LOOK', ${id7}, 'DONE');
    `)
    planReply = '```json\n{"folders":[{"name":"原神图","works":["原神"]}]}\n```'
    await org.startOrganize()
    await vi.waitFor(() => expect(org.getOrganizeState().phase).toBe('PLAN_READY'))
    // 出方案时又导入了 7（换成一张新的还没分级的图）
    await pg.exec(`DELETE FROM ai_job WHERE image_id = ${id7}`)
    await pg.query(`UPDATE image SET rating = 'UNKNOWN', rating_source = NULL WHERE id = $1`, [id7])
    expect(await org.approveOrganize(org.getOrganizeState().plan!)).toBe(1)
    expect(org.getOrganizeState().phase).toBe('FOLLOWING')

    // 7 判完：排进看图，只走批量（优先级为负）
    await pg.query(`UPDATE image SET rating = 'GENERAL', rating_source = 'MODEL' WHERE id = $1`, [id7])
    await org.onRatingBatch()
    const job = await pg.query<{ priority: number }>(`SELECT priority FROM ai_job WHERE kind = 'LOOK' AND image_id = $1`, [id7])
    expect(job.rows.map((r) => r.priority)).toEqual([-1])
    expect(org.getOrganizeState().phase).toBe('FOLLOWING')

    // 7 看完（有“原神”）：按批过的方案分进“原神图”，分级和看图都做完了，回到空闲
    await pg.query(`UPDATE ai_job SET status = 'DONE' WHERE image_id = $1`, [id7])
    await pg.query(
      `INSERT INTO image_ai_result (image_id, kind, model, result, field_status) VALUES ($1, 'IDENTIFY', 'm', '{"name":"","character":"","work":"原神","tags":[],"source":"","description":""}', '{"work":"PENDING"}')`,
      [id7]
    )
    await org.checkLooking()
    expect(org.getOrganizeState().phase).toBe('IDLE')
    expect((await sugg.listSuggestions(id7)).map((s) => [s.kind, s.value])).toContainEqual(['dir', '原神图'])
  })

  it('停下后重新开始：取消过、出错过的图重新算待看、重新排队；自动看图不会把取消的再排回来', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, thumb_ready, rating, rating_source) VALUES ('h9', 'JPG', 1, 1, 'GENERAL', 'MODEL'), ('h10', 'JPG', 1, 1, 'GENERAL', 'MODEL');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT id, 1, content_hash || '.jpg', now() FROM image WHERE content_hash IN ('h9', 'h10');
      INSERT INTO ai_job (kind, image_id, status) SELECT 'LOOK', id, 'CANCELLED' FROM image WHERE content_hash = 'h9';
      INSERT INTO ai_job (kind, image_id, status, remote_id) SELECT 'LOOK', id, 'FAILED', 'batch-x' FROM image WHERE content_hash = 'h10';
    `)
    const ids = (await pg.query<{ id: number }>(`SELECT id FROM image WHERE content_hash IN ('h9', 'h10') ORDER BY id`)).rows.map((r) => Number(r.id))
    const { countLookCandidates } = await import('../../src/main/repositories/aiResultRepository')
    expect(await countLookCandidates(new Date(0))).toBe(0)
    expect((await org.estimateOrganize()).toLook).toBe(2)
    const s = await org.startOrganize()
    expect(s.phase).toBe('LOOKING')
    const jobs = await pg.query<{ image_id: number; status: string }>(
      `SELECT image_id, status::text AS status FROM ai_job WHERE kind = 'LOOK' AND image_id = ANY($1) ORDER BY id`,
      [ids]
    )
    expect(jobs.rows.map((r) => [Number(r.image_id), r.status])).toEqual([
      [ids[0], 'CANCELLED'],
      [ids[1], 'CANCELLED'],
      [ids[0], 'QUEUED'],
      [ids[1], 'QUEUED']
    ])
    expect(s.looked).toEqual({ done: 0, total: 2 })
    await org.cancelOrganize()
  })

  it('启动时将上次待确认的方案推给界面', async () => {
    const onState = vi.fn()
    org.configureOrganize({ onState, onSuggested: () => undefined })
    const saved = { phase: 'PLAN_READY', plan: [{ name: '风景', tags: ['风景'], characters: [], works: [], isNew: false }], error: null }
    await upsertSettings([{ key: 'ai.organize', value: saved }])
    await org.restoreOrganize()
    expect(onState).toHaveBeenCalledWith(saved)
    await org.cancelOrganize()
  })

  it('已有同名目录直接出方案，停止后迟到的云端方案不会重新打开确认窗口', async () => {
    const { resetOrganizeRules } = await import('../../src/main/services/ai/aiPolicy')
    await resetOrganizeRules()
    const { pg } = getDatabase()
    await pg.exec(`
      UPDATE ai_job SET status = 'DONE', finished_at = now() WHERE kind = 'LOOK' AND status = 'QUEUED';
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (4, 2, 'MANUAL', 'ACCEPTED');
    `)
    const beforeLocal = prompts.length
    await org.startOrganize()
    await vi.waitFor(() => expect(org.getOrganizeState().phase).toBe('PLAN_READY'))
    expect(prompts).toHaveLength(beforeLocal)
    await org.cancelOrganize()
    // 增加没有同名目录的标签，确保下面确实会发起异步规划请求。
    await pg.exec(`
      with fresh as (insert into tag(name,category_id) values ('尚未归类的主题',4) returning id)
      insert into image_tag(image_id,tag_id,source,status) select 4,id,'MANUAL','ACCEPTED' from fresh
    `)
    planReply = '```json\n{"folders":[{"name":"风景","tags":["风景"]}]}\n```'
    const onState = vi.fn()
    org.configureOrganize({ onState, onSuggested: () => undefined })
    let release = (): void => undefined
    planGate = new Promise<void>((resolve) => { release = resolve })
    const calls = prompts.length
    try {
      await org.startOrganize()
      await vi.waitFor(() => expect(prompts).toHaveLength(calls + 1))
      expect(org.getOrganizeState().phase).toBe('PLANNING')
      await org.cancelOrganize()
    } finally {
      planGate = undefined
      release()
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(org.getOrganizeState().phase).toBe('IDLE')
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'PLAN_READY' }))
  })

  it('重新启动后新图直接采用手动确认的分类规则，目录名可与标签不同', async () => {
    const {pg} = getDatabase()
    await pg.exec("update image set is_r18=true, rating='EXPLICIT', rating_source='MANUAL'; update ai_job set status='DONE' where kind='LOOK'")
    const plan = [{name:'选定归档',tags:['回归标签'],characters:[],works:[],isNew:true}]
    await upsertSettings([{key:'ai.organize',value:{phase:'PLAN_READY',plan,error:null}}])
    await org.restoreOrganize()
    await org.approveOrganize(plan)
    await closeDatabase()
    const again = await openDatabase(join(dir,'pgdata'),resolve('drizzle'))
    await org.restoreOrganize()
    await again.pg.exec(`
      insert into tag(name,category_id) values('回归标签',4);
      insert into image(content_hash,format,byte_size,thumb_ready,rating,rating_source) values('confirmed-new','JPG',1,1,'GENERAL','MANUAL');
      insert into image_file(image_id,root_id,rel_path,mtime) select id,1,'confirmed-new.jpg',now() from image where content_hash='confirmed-new';
      insert into image_tag(image_id,tag_id,source,status) select i.id,t.id,'MANUAL','ACCEPTED' from image i, tag t where i.content_hash='confirmed-new' and t.name='回归标签';
      insert into ai_job(kind,image_id,status) select 'LOOK',id,'DONE' from image where content_hash='confirmed-new';
    `)
    const before = prompts.length
    await org.startOrganize()
    await vi.waitFor(async () => {
      const rows = await again.pg.query("select result->>'dir' as dir from image_ai_result a join image i on i.id=a.image_id where i.content_hash='confirmed-new' and a.kind='ORGANIZE'")
      expect(rows.rows).toEqual([{dir:'选定归档'}])
    })
    expect(prompts).toHaveLength(before)
    await vi.waitFor(() => expect(org.getOrganizeState().phase).toBe('IDLE'))
  })

  it('首次创建的目标随用户改名，删除后既有建议和新增分类都不会重建旧目录', async () => {
    const { ensureSuggestionTarget, renameCategoryFolder, deleteCategoryFolder } = await import('../../src/main/services/fileOps/folderOpsService')
    const { readSetting } = await import('../../src/main/repositories/appSettingRepository')
    const { decideSuggestion } = await import('../../src/main/services/ai/suggestionService')
    const rules = () => readSetting<Array<{name:string;isNew:boolean}>>('ai.organize.rules')
    expect(await rules()).toMatchObject([{name:'选定归档',isNew:true}])
    await ensureSuggestionTarget('选定归档')
    expect(await rules()).toMatchObject([{name:'选定归档',isNew:false}])
    await renameCategoryFolder({kind:'category',path:'选定归档'},'归档已调整')
    expect(await rules()).toMatchObject([{name:'归档已调整',isNew:false}])
    await deleteCategoryFolder({kind:'category',path:'归档已调整'})
    const {pg} = getDatabase()
    const id = Number((await pg.query<{id:number}>("select id from image where content_hash='confirmed-new'")).rows[0].id)
    await expect(decideSuggestion(id,'dir',true)).rejects.toThrow('不存在')
    expect(existsSync(join(library,'归档已调整'))).toBe(false)
    await pg.exec(`
      insert into image(content_hash,format,byte_size,thumb_ready,rating,rating_source) values('after-delete','JPG',1,1,'GENERAL','MANUAL');
      insert into image_file(image_id,root_id,rel_path,mtime) select id,1,'after-delete.jpg',now() from image where content_hash='after-delete';
      insert into image_tag(image_id,tag_id,source,status) select i.id,t.id,'MANUAL','ACCEPTED' from image i,tag t where i.content_hash='after-delete' and t.name='回归标签';
      insert into ai_job(kind,image_id,status) select 'LOOK',id,'DONE' from image where content_hash='after-delete';
    `)
    planReply = JSON.stringify({folders:[{name:'归档已调整',tags:['回归标签']}]})
    await org.startOrganize()
    await vi.waitFor(() => expect(org.getOrganizeState().phase).toBe('PLAN_READY'))
    expect(org.getOrganizeState().plan).toBeNull()
    expect((await pg.query("select 1 from image_ai_result a join image i on i.id=a.image_id where i.content_hash='after-delete' and kind='ORGANIZE'")).rows).toEqual([])
    expect(existsSync(join(library,'选定归档'))).toBe(false)
    await org.cancelOrganize()
  })
})
