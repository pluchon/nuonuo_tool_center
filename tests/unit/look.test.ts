import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isAssistRecord, parseAssistJson } from '../../src/shared/assistJson'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { localClues } from '../../src/main/services/ai/localClues'
import { hashFile } from '../../src/main/services/scan/imageProbe'
import { prepareImage, toDataUrl } from '../../src/main/services/ai/imagePrep'
import { normalizeFields, pendingStatus } from '../../src/main/services/ai/suggestion'

// 模型调用换成脚本：看图时返回预设的回复，记下请求
const calls: Array<{ text: string; search: boolean | undefined; image: boolean }> = []
let reply: { text: string; sources: Array<{ url: string }> } = { text: '', sources: [] }
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  searchCall: vi.fn(async (meta: { text: string; search?: boolean; imageDataUrl?: string }) => {
    calls.push({ text: meta.text, search: meta.search, image: !!meta.imageDataUrl?.startsWith('data:image/jpeg;base64,') })
    return { ...reply, usage: {} }
  }),
  getBailianClient: vi.fn(),
  recordBatchUsage: vi.fn(),
  chatCall: vi.fn()
}))
vi.mock('electron', () => ({
  clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'test',
    encryptStringAsync: async () => Buffer.from('仅用于测试')
  }
}))

const look = await import('../../src/main/services/ai/lookService')
const sugg = await import('../../src/main/services/ai/suggestionService')
const { listGallery } = await import('../../src/main/services/galleryService')

describe('本地线索', () => {
  it('Pixiv、图站、yande.re 文件名和相机型号', () => {
    expect(localClues('12345678_p0.png', null)).toMatchObject({ source: 'https://www.pixiv.net/artworks/12345678', photo: false })
    expect(localClues('12345678_p3_master1200.jpg', null).source).toBe('https://www.pixiv.net/artworks/12345678')
    const booru = localClues('__ganyu_(genshin_impact)_drawn_by_someone_artist__0123456789abcdef0123456789abcdef.jpg', null)
    expect(booru).toMatchObject({ character: 'ganyu', artist: 'someone artist', source: null })
    expect(localClues('yande.re 98765 ganyu genshin.jpg', null).source).toBe('https://yande.re/post/show/98765')
    const photo = localClues('IMG_0001.JPG', { make: 'Canon', model: 'EOS R6' })
    expect(photo.photo).toBe(true)
    expect(photo.notes.join()).toContain('Canon EOS R6')
    expect(localClues('随便一张.jpg', null)).toMatchObject({ source: null, photo: false, notes: ['文件名：随便一张.jpg'] })
  })
})

describe('建议整理', () => {
  const ctx = { canonical: new Map([['椰羊', '甘雨'], ['genshin', '原神'], ['甘雨', '甘雨'], ['原神', '原神']]), existing: ['猫'] }

  it('对齐叫法、去重、不和角色作品已有标签重复、字数和个数上限、出处只要链接', () => {
    const f = normalizeFields(
      {
        name: '一个特别特别特别特别长的名字超过十五个字',
        character: '椰羊',
        work: 'Genshin',
        tags: ['表情包', '表情包', '甘雨', '猫', 'Q版', '可爱', '举牌', '文字', '白底'],
        source: 'pixiv 某某',
        description: ' 甘雨举着牌子 '
      },
      ctx
    )
    expect(f).toEqual({
      name: '一个特别特别特别特别长的名字超',
      character: '甘雨',
      work: '原神',
      tags: ['表情包', 'Q版', '可爱', '举牌', '文字', '白底'],
      source: '',
      description: '甘雨举着牌子'
    })
    expect(Object.keys(pendingStatus(f))).toEqual(['name', 'tag:表情包', 'tag:Q版', 'tag:可爱', 'tag:举牌', 'tag:文字', 'tag:白底', 'who', 'work'])
    const many = Array.from({ length: 16 }, (_, index) => `标签${index + 1}`)
    expect(normalizeFields({ tags: many }, ctx).tags).toEqual(many.slice(0, 15))
    expect(normalizeFields(null, ctx)).toEqual({ name: '', character: '', work: '', tags: [], source: '', description: '' })
  })

  it('外部 AI 的回复：读取 JSON 代码块或正文对象，并识别标准字段', () => {
    const text = '好的，结果如下：\n```json\n{"name": "好椰", "character": "甘雨", "tags": ["表情包", ""], "source": ""}\n```\n希望有帮助'
    const o = parseAssistJson(text)
    expect(o).toMatchObject({ name: '好椰' })
    expect(isAssistRecord(o!)).toBe(true)
    expect(isAssistRecord({ 标签: ['海边'] })).toBe(false)
    expect(isAssistRecord({ tags: '海边、日落' })).toBe(false)
    expect(parseAssistJson('{"name":"x"}')).toEqual({ name: 'x' })
    expect(parseAssistJson('没有 json')).toBeNull()
    expect(parseAssistJson('```json\n[1,2]\n```')).toBeNull()
  })
})

describe('看图队列和 AI 建议', () => {
  let dir: string
  let source: string
  const states: number[] = []
  let suggested = 0

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-look-'))
    source = join(dir, 'pics')
    mkdirSync(source)
    process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    // 四张测试图：普通图、Pixiv 文件名、R-18、本地模型判过但分数不明（UNKNOWN，不放行）
    const hashes: string[] = []
    for (const [i, name] of ['a.jpg', '12345678_p0.jpg', 'c.jpg', 'd.jpg'].entries()) {
      const file = join(source, name)
      await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 80 + i * 35, g: 160, b: 180 } } }).jpeg().toFile(file)
      hashes.push(await hashFile(file))
    }
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18) VALUES
        ('${hashes[0]}', 'JPG', 1, 1600, 900, 1, 'GENERAL', 'MODEL', false),
        ('${hashes[1]}', 'JPG', 1, 1600, 900, 1, 'SENSITIVE', 'MODEL', false),
        ('${hashes[2]}', 'JPG', 1, 1600, 900, 1, 'EXPLICIT', 'MODEL', true),
        ('${hashes[3]}', 'JPG', 1, 1600, 900, 1, 'UNKNOWN', 'MODEL', false),
        ('h5', 'JPG', 1, 1600, 900, 1, 'UNKNOWN', NULL, false);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
        (1, 1, 'a.jpg', now()), (2, 1, '12345678_p0.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.jpg', now()), (5, 1, 'e.jpg', now());
      INSERT INTO tag (name, category_id) VALUES ('甘雨', 1), ('原神', 2), ('猫', 4);
      INSERT INTO tag_alias (tag_id, name) VALUES (1, '椰羊');
      -- 自动看图从这个时间起导入的图（第一次启用时是“现在”，这里提前，让上面几张算新图）
      INSERT INTO app_setting (key, value) VALUES ('ai.lookSince', '"2000-01-01T00:00:00.000Z"');
    `)
    look.configureLook({
      thumbsDir: join(dir, 'thumbs'),
      tempDir: join(dir, 'tmp'),
      canRun: () => true,
      onState: (s) => states.push(s.count),
      onSuggested: () => suggested++
    })
  })

  afterAll(async () => {
    await look.stopLook()
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  it('原图已更换时仅使用原内容对应的缩略图，缺少缩略图时停止准备云端输入', async () => {
    const cached = join(dir, 'verified-thumbs')
    mkdirSync(cached)
    const contentHash = await hashFile(join(source, 'a.jpg'))
    const info = { rootPath: source, relPath: 'c.jpg', contentHash }
    expect(await prepareImage(info, cached, 512)).toBeNull()
    const thumb = join(cached, contentHash + '.webp')
    await sharp(join(source, 'a.jpg')).resize(100).webp().toFile(thumb)
    expect(await prepareImage(info, cached, 512)).toBe(await toDataUrl(thumb, 512))
  })

  // 等队列里没有进行中的
  async function idle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const s = await look.getLookState()
      if (!s.rows.some((r) => r.state !== 'FAILED')) {
        return
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('队列一直没空')
  }

  it('只排过了闸门的非 R-18 新图；看图带本地线索，有出处线索的不联网；结果进 AI 建议，描述直接补上', async () => {
    reply = {
      text: '```json\n{"name": "落叶小猫", "character": "椰羊", "work": "", "tags": ["猫", "秋天"], "source": "https://example.com/made-up", "description": "一只猫"}\n```',
      sources: [{ url: 'https://example.com/real' }]
    }
    const { initAiCredentialSettings, saveAiCredentialSettings } = await import('../../src/main/services/aiCredentialSettings')
    process.env.DASHSCOPE_API_KEY = ''
    vi.stubEnv('ALIYUN_ACCESS_KEY_ID', '')
    vi.stubEnv('ALIYUN_ACCESS_KEY_SECRET', '')
    try {
      await initAiCredentialSettings(dir)
    } finally {
      vi.unstubAllEnvs()
    }
    await look.initLook()
    expect(await look.getLookState()).toMatchObject({ needsApiKey: true, count: 2, activity: 'queued' })
    expect(calls).toHaveLength(0)
    // 通过实际保存入口添加密钥，无须再次排队或重启应用。
    try {
      await saveAiCredentialSettings({ dashscopeApiKey: 'test-key-not-real' })
      expect((await look.getLookState()).needsApiKey).toBe(false)
    } finally {
      process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
      await saveAiCredentialSettings({ dashscopeApiKey: null })
    }
    await idle()
    // 第 1、2 张放行；R-18、分数不明、没判过的都不排
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.image)).toBe(true)
    const pixiv = calls.find((call) => call.text.includes('Pixiv 作品 12345678'))
    expect(pixiv?.search).toBe(false)
    expect(calls.find((call) => call !== pixiv)?.search).toBe(true)
    expect(suggested).toBe(2)

    const a = await sugg.listSuggestions(1)
    // 模型自己写的链接不在搜索结果里，丢掉；叫法对齐成“甘雨”；已有标签以外的保留
    expect(a.map((s) => `${s.kind}:${s.value}`)).toEqual(['name:落叶小猫', 'tag:猫', 'tag:秋天', 'who:甘雨'])
    const b = await sugg.listSuggestions(2)
    expect(b.find((s) => s.kind === 'src')?.value).toBe('https://www.pixiv.net/artworks/12345678')
    const { pg } = getDatabase()
    expect((await pg.query<{ description: string }>('SELECT description FROM image WHERE id = 1')).rows[0].description).toBe('一只猫')

    // 再排一次不会重复排
    await look.enqueueNewImages()
    await idle()
    expect(calls).toHaveLength(2)
  })

  it('逐项采用 / 不要、全部采用；处理完离开 AI 建议；事件流记下来', async () => {
    let left = await sugg.decideSuggestion(1, 'name', true)
    expect(left.map((s) => s.key)).toEqual(['tag:猫', 'tag:秋天', 'who'])
    left = await sugg.decideSuggestion(1, 'tag:秋天', false)
    left = await sugg.acceptAllSuggestions(1)
    expect(left).toEqual([])
    const { pg } = getDatabase()
    expect((await pg.query<{ display_name: string }>('SELECT display_name FROM image WHERE id = 1')).rows[0].display_name).toBe('落叶小猫')
    const tags = (await pg.query<{ name: string; cat: string }>(
      `SELECT t.name, c.name AS cat FROM image_tag it JOIN tag t ON t.id = it.tag_id JOIN tag_category c ON c.id = t.category_id WHERE it.image_id = 1 AND it.status = 'ACCEPTED' ORDER BY t.name`
    )).rows
    expect(tags).toEqual([
      { name: '猫', cat: '主题' },
      { name: '甘雨', cat: '角色' }
    ])
    await sugg.acceptAllSuggestions(2)
    expect((await pg.query<{ source: string }>('SELECT source FROM image WHERE id = 2')).rows[0].source).toBe('https://www.pixiv.net/artworks/12345678')
    await expect(sugg.decideSuggestion(1, 'name', true)).rejects.toThrow('处理过了')
    const events = (await pg.query<{ kind: string }>('SELECT kind FROM ai_event ORDER BY id')).rows.map((r) => r.kind)
    expect(events.filter((k) => k === 'suggestion.reject')).toHaveLength(1)
    expect(events.filter((k) => k === 'suggestion.accept').length).toBeGreaterThan(3)
  })

  it('外部 AI：R-18 图也能用，叫法对齐后存成外部来源的建议；提示词只提供整理意图和可导入格式', async () => {
    const prompt = await sugg.assistPrompt(3)
    expect(prompt).toBe(await sugg.assistPrompt(1))
    expect(JSON.parse(prompt.split('```json\n')[1].split('\n```')[0])).toMatchObject({ name: '', tags: [] })
    await expect(sugg.assistPrompt(999999)).rejects.toThrow('不在图库')
    const n = await sugg.importAssist(3, { name: '某张图', character: '椰羊', tags: ['猫', '猫'], source: 'https://example.com/x' })
    expect(n).toBe(4)
    const items = await sugg.listSuggestions(3)
    expect(items.every((s) => s.origin === 'EXTERNAL')).toBe(true)
    expect(items.find((s) => s.kind === 'who')?.value).toBe('甘雨')
    await expect(sugg.importAssist(3, {})).rejects.toThrow()
    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    const cloudCalls = vi.mocked(chatCall).mock.calls.length
    await expect(sugg.importAssist(3, '{"name":"","tags":[]}')).rejects.toThrow('没整理出能用的内容')
    expect(await sugg.importAssist(3, '{"description":"树影落在墙上"}')).toBe(0)
    await expect(sugg.importAssist(3, '{"description":"覆盖旧描述"}')).rejects.toThrow()
    expect((await getDatabase().pg.query<{description: string}>('select description from image where id=3')).rows[0].description).toBe('树影落在墙上')
    expect(vi.mocked(chatCall).mock.calls.length).toBe(cloudCalls)
    vi.mocked(chatCall).mockResolvedValueOnce({
      message: { role: 'assistant', content: '{"tags":["蓝调夜景"]}', refusal: null },
      finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, searchCount: 0 }
    })
    expect(await sugg.importAssist(3, '这张可以用蓝调夜景做标签', dir)).toBe(1)
    const request = vi.mocked(chatCall).mock.lastCall![0]
    expect(request.imageId).toBe(3)
    expect(request.messages[1].content).toEqual([{ type: 'text', text: expect.stringContaining('蓝调夜景') }])
  })

  it('只默认标记被明确拦截的输入图片，复核可以改回，其他图片仍继续处理', async () => {
    const { searchCall } = await import('../../src/main/services/ai/bailianClient')
    const { pg } = getDatabase()
    const inputRejected = Object.assign(new Error('Input image data may contain inappropriate content.'), { code: 'DataInspectionFailed', status: 400 })
    await pg.exec(`INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
      VALUES (1, 'ORGANIZE', 'test', '{"dir":"示例目录"}', '{"dir":"PENDING"}')`)
    vi.mocked(searchCall).mockRejectedValueOnce(inputRejected)
    await look.lookNow(1)
    await idle()
    expect(await look.getLookState()).toEqual({ count: 0, activity: 'idle', rows: [], canCancel: false, needsApiKey: false })
    expect(await sugg.listSuggestions(1)).toEqual([
      { key: 'r18Review', kind: 'r18Review', value: '云端内容审核未通过', origin: 'NONO' }
    ])
    expect((await listGallery({ view: 'ai', sort: 'new' })).items.find((item) => item.imageId === 1)).toMatchObject({ isR18: true, aiDir: null })
    expect(await sugg.decideMany([1], false)).toEqual({ done: 0, failed: 0, error: null })
    expect(await sugg.acceptAllSuggestions(1)).toHaveLength(1)

    // 旧版残留的失败任务在启动时归档，原复核建议保留。
    await pg.exec(`UPDATE ai_job SET status = 'FAILED' WHERE image_id = 1 AND error = '云端内容审核未通过'`)
    expect((await look.getLookState()).count).toBe(1)
    await look.initLook()
    expect((await look.getLookState()).count).toBe(0)
    expect(await sugg.listSuggestions(1)).toHaveLength(1)

    vi.mocked(searchCall).mockRejectedValueOnce(Object.assign(new Error('Output data may contain inappropriate content.'), { code: 'data_inspection_failed', status: 400 }))
    await look.lookNow(2)
    await idle()
    expect(await sugg.listSuggestions(2)).toEqual([])
    expect((await pg.query('SELECT is_r18 FROM image WHERE id = 2')).rows).toEqual([{ is_r18: false }])
    expect((await look.getLookState()).rows).toMatchObject([{ imageId: 2, state: 'FAILED' }])

    // 确认取消后恢复原有的目录建议，再次收到同类拒绝也沿用用户确认。
    expect((await sugg.decideSuggestion(1, 'r18Review', false)).map(({ kind }) => kind)).toEqual(['dir'])
    vi.mocked(searchCall).mockRejectedValueOnce(inputRejected)
    await look.lookNow(1)
    await idle()
    expect((await pg.query('SELECT is_r18, rating_source FROM image WHERE id = 1')).rows).toEqual([{ is_r18: false, rating_source: 'MANUAL' }])
    expect((await sugg.listSuggestions(1)).map(({ kind }) => kind)).toEqual(['dir'])
    await pg.exec(`DELETE FROM ai_job WHERE image_id = 1 AND status = 'DONE'; DELETE FROM image_tag WHERE image_id = 1`)
    const { countLookCandidates } = await import('../../src/main/repositories/aiResultRepository')
    expect(await countLookCandidates(new Date(0), true)).toBe(0)
    await look.cancelAllLooks()
  })

  it('出错挂标签可重试；全部取消后不再自动排', async () => {
    // 手动“让诺诺看看”也要过上云闸门：R-18 不行，本地还没判完（分数不明）不行
    await expect(look.lookNow(3)).rejects.toThrow('R-18')
    await expect(look.lookNow(4)).rejects.toThrow('本地分级')
    const { pg: db } = getDatabase()
    await db.exec(`UPDATE image SET rating = 'GENERAL' WHERE id = 4`)
    const { searchCall } = await import('../../src/main/services/ai/bailianClient')
    vi.mocked(searchCall).mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))
    await look.lookNow(4)
    await idle()
    let s = await look.getLookState()
    expect(s.activity).toBe('idle')
    expect(s.rows).toMatchObject([{ imageId: 4, state: 'FAILED', error: '超时' }])
    const truncated = { text: '{"name":', sources: [], usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, searchCount: 0 } }
    vi.mocked(searchCall).mockResolvedValueOnce(truncated)
    await look.retryLook(s.rows[0].jobId)
    await idle()
    expect((await look.getLookState()).rows).toMatchObject([{ imageId: 4, state: 'FAILED', error: '看图结果格式异常' }])
    expect((await db.query('SELECT id FROM image_ai_result WHERE image_id = 4')).rows).toEqual([])
    await look.retryLook(s.rows[0].jobId)
    await idle()
    s = await look.getLookState()
    expect(s.count).toBe(0)
    expect((await sugg.listSuggestions(4)).length).toBeGreaterThan(0)

    // 新来一张，取消掉之后不会被重新排进去
    const { pg } = getDatabase()
    await pg.exec(`UPDATE image SET rating = 'GENERAL', rating_source = 'MODEL' WHERE id = 5`)
    vi.mocked(searchCall).mockImplementationOnce(() => new Promise(() => undefined))
    look.configureLook({ thumbsDir: join(dir, 'thumbs'), tempDir: join(dir, 'tmp'), canRun: () => false, onState: () => undefined, onSuggested: () => undefined })
    await look.enqueueNewImages()
    expect((await look.getLookState()).count).toBe(1)
    expect(await look.cancelAllLooks()).toBe(1)
    await look.enqueueNewImages()
    expect((await look.getLookState()).count).toBe(0)
  })
})
