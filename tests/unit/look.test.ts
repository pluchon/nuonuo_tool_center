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
const calls: Array<{
  text: string
  instructions: string
  search: boolean | undefined
  enableThinking: boolean | undefined
  thinkingBudget: number | undefined
  image: boolean
}> = []
let reply: { text: string; sources: Array<{ url: string }> } = { text: '', sources: [] }
function recordSearchCall(meta: {
  text: string
  instructions: string
  search?: boolean
  enableThinking?: boolean
  thinkingBudget?: number
  imageDataUrl?: string
}) {
  calls.push({
    text: meta.text,
    instructions: meta.instructions,
    search: meta.search,
    enableThinking: meta.enableThinking,
    thinkingBudget: meta.thinkingBudget,
    image: !!meta.imageDataUrl?.startsWith('data:image/jpeg;base64,')
  })
  return { ...reply, usage: {} }
}
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  searchCall: vi.fn(async (meta: Parameters<typeof recordSearchCall>[0]) => recordSearchCall(meta)),
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

  it('提取有意义的父目录线索并过滤通用目录与日期，格式化本地模型角色与视觉特征', () => {
    const withFolders = localClues('001.jpg', null, { relPath: 'pics\\2025-01\\原神\\甘雨\\001.jpg' })
    expect(withFolders.notes).toContain('目录线索：原神 / 甘雨')

    const genericOnly = localClues('002.jpg', null, { relPath: 'Downloads/壁纸/2025/新建文件夹/002.jpg' })
    expect(genericOnly.notes.some((n) => n.startsWith('目录线索：'))).toBe(false)

    const withVisual = localClues('12345678_p0.png', null, {
      relPath: '图库/明日方舟/阿米娅/12345678_p0.png',
      visualHints: {
        characters: [
          { name: 'amiya_(arknights)', score: 0.874 },
          { name: 'texas', score: 0.412 },
          { name: 'c3', score: 0.39 },
          { name: 'c4', score: 0.38 },
          { name: 'c5', score: 0.37 },
          { name: 'c6', score: 0.36 }
        ],
        tags: [
          '1girl', 'solo', 'looking_at_viewer', 'simple_background',
          'brown_hair', 'blue_eyes', 'rabbit_ears', 'ahoge', 'coat',
          'hair_ornament', 'dress', 'sword', 'halo', 'glasses',
          'twintails', 'wings', 'tail', 'witch_hat'
        ]
      }
    })
    const joined = withVisual.notes.join('\n')
    expect(joined).toContain('目录线索：明日方舟 / 阿米娅')
    expect(joined).toContain('本地模型候选角色（仅供参考，请结合画面细节与联网搜索核实后再采用）：amiya (arknights) 87%、texas 41%、c3 39%、c4 38%、c5 37%')
    expect(joined).not.toContain('c6 36%')
    const traitsLine = withVisual.notes.find((n) => n.startsWith('本地模型视觉特征：')) ?? ''
    expect(traitsLine).toContain('brown_hair')
    expect(traitsLine).toContain('rabbit_ears')
    expect(traitsLine).not.toContain('1girl')
    expect(traitsLine).not.toContain('looking_at_viewer')
    expect(traitsLine.replace('本地模型视觉特征：', '').split('、')).toHaveLength(12)
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

  it('只排过了闸门的非 R-18 新图；看图带本地线索，Pixiv 图也开启联网核查；结果进 AI 建议，描述直接补上', async () => {
    reply = {
      text: '```json\n{"name": "落叶小猫", "character": "椰羊", "work": "", "tags": ["猫", "秋天"], "source": "https://example.com/made-up", "description": "一只猫"}\n```',
      sources: [{ url: 'https://example.com/real' }]
    }
    const { initAiCredentialSettings, saveAiCredentialSettings } = await import('../../src/main/services/aiCredentialSettings')
    process.env.DASHSCOPE_API_KEY = ''
    await initAiCredentialSettings(dir)
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
    expect(pixiv?.search).toBe(true)
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
    expect(await look.getLookState()).toEqual({
      count: 0,
      activity: 'idle',
      rows: [],
      canCancel: false,
      needsApiKey: false,
      reorganizing: false,
      activeImageIds: []
    })
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
    vi.mocked(searchCall)
      .mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))
      .mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))
    await look.lookNow(4)
    await idle()
    let s = await look.getLookState()
    expect(s.activity).toBe('idle')
    expect(s.rows).toMatchObject([{ imageId: 4, state: 'FAILED', error: '超时' }])

    // 仅联网主请求超时时，自动降级为纯视觉快速识别并成功落库（不直接标 FAILED）
    vi.mocked(searchCall)
      .mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))
      .mockResolvedValueOnce({
        text: '```json\n{"name":"纯视觉兜底","character":"","work":"","tags":["夜空"],"source":"","description":"联网超时后纯视觉识别完成"}\n```',
        sources: [],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, searchCount: 0 }
      })
    await look.retryLook(s.rows[0].jobId)
    await idle()
    expect((await sugg.listSuggestions(4)).find((item) => item.kind === 'name')?.value).toBe('纯视觉兜底')

    // 重置为失败任务继续测格式异常后的二次重试
    await db.exec(`DELETE FROM image_ai_result WHERE image_id = 4; UPDATE ai_job SET status = 'FAILED', error = '超时' WHERE image_id = 4`)
    s = await look.getLookState()
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

  it('相机拍摄的照片看图时不开启联网搜索', async () => {
    const { searchCall } = await import('../../src/main/services/ai/bailianClient')
    vi.mocked(searchCall).mockReset()
    vi.mocked(searchCall).mockImplementation(async (meta) => recordSearchCall(meta) as never)
    const photoFile = join(source, 'IMG_9999.jpg')
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 100, g: 140, b: 200 } } }).jpeg().toFile(photoFile)
    const photoHash = await hashFile(photoFile)
    const { pg } = getDatabase()
    const inserted = await pg.query<{ id: number }>(
      `INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18, exif)
       VALUES ($1, 'JPG', 1, 1600, 900, 1, 'GENERAL', 'MODEL', false, '{"make":"Sony","model":"ILCE-7M4"}'::jsonb)
       RETURNING id`,
      [photoHash]
    )
    const photoId = Number(inserted.rows[0].id)
    await pg.query(`INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES ($1, 1, 'IMG_9999.jpg', now())`, [photoId])

    look.configureLook({
      thumbsDir: join(dir, 'thumbs'),
      tempDir: join(dir, 'tmp'),
      canRun: () => true,
      onState: (s) => states.push(s.count),
      onSuggested: () => suggested++
    })
    await look.lookNow(photoId)
    await idle()
    const last = calls.at(-1)
    expect(last?.search).toBe(false)
    expect(last?.enableThinking).toBe(false)
    expect(last?.text).toContain('Sony ILCE-7M4')
  })

  it('清晰图不触发思考；needs_thinking 或有本地角色线索但未识别出角色时触发一次深度思考，失败时回退初次结果', async () => {
    const { searchCall } = await import('../../src/main/services/ai/bailianClient')
    const { pg } = getDatabase()
    const emptyFields = { name: '未知人物', character: '', work: '', tags: [], source: '', description: '' }
    const clearFields = { ...emptyFields, character: '甘雨' }
    const photoClues = localClues('IMG_0001.jpg', { make: 'Canon', model: 'EOS R6' })
    const animeClues = localClues('anime.jpg', null)
    const hints = { characters: [{ name: 'ganyu', score: 0.85 }] }
    expect(look.shouldEscalateThinking({ needs_thinking: true }, emptyFields, photoClues, hints)).toBe(false)
    expect(look.shouldEscalateThinking({}, clearFields, animeClues, hints)).toBe(false)
    expect(look.shouldEscalateThinking({ needs_thinking: true }, clearFields, animeClues, null)).toBe(true)
    expect(look.shouldEscalateThinking({}, emptyFields, animeClues, hints)).toBe(true)

    let colorOffset = 0
    const createImage = async (fileName: string, hintsJson: string | null) => {
      colorOffset += 15
      const f = join(source, fileName)
      await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120 + colorOffset, g: 130, b: 140 } } }).jpeg().toFile(f)
      const h = await hashFile(f)
      const row = await pg.query<{ id: number }>(
        `INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18, visual_features)
         VALUES ($1, 'JPG', 1, 800, 600, 1, 'GENERAL', 'MODEL', false, $2::jsonb) RETURNING id`,
        [h, hintsJson]
      )
      const id = Number(row.rows[0].id)
      await pg.query(`INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES ($1, 1, $2, now())`, [id, fileName])
      return id
    }

    // 1. 清晰图只调用 1 次且 enableThinking: false
    const clearId = await createImage('clear-char.jpg', null)
    calls.length = 0
    vi.mocked(searchCall).mockImplementationOnce(async (meta) => {
      recordSearchCall(meta)
      return {
        text: '```json\n{"name":"蓝裙甘雨","character":"甘雨","work":"原神","tags":["微笑"],"source":"","description":"甘雨在微笑"}\n```',
        sources: [],
        usage: {}
      } as never
    })
    await look.lookNow(clearId)
    await idle()
    expect(calls).toHaveLength(1)
    expect(calls[0].enableThinking).toBe(false)
    expect(calls[0].thinkingBudget).toBeUndefined()

    // 2. needs_thinking: true 时仅升级 1 次，携带相同 instructions、thinkingBudget: 1024 并合并来源
    const hardId = await createImage('hard-char.jpg', null)
    calls.length = 0
    vi.mocked(searchCall)
      .mockImplementationOnce(async (meta) => {
        recordSearchCall(meta)
        return {
          text: '```json\n{"name":"少女","character":"","work":"","tags":["白发"],"source":"https://example.com/p1","description":"待确认","needs_thinking":true}\n```',
          sources: [{ url: 'https://example.com/p1' }],
          usage: {}
        } as never
      })
      .mockImplementationOnce(async (meta) => {
        recordSearchCall(meta)
        return {
          text: '```json\n{"name":"白发千雪","character":"千雪","work":"某作品","tags":["白发"],"source":"https://example.com/p2","description":"已确认角色"}\n```',
          sources: [{ url: 'https://example.com/p2' }],
          usage: {}
        } as never
      })
    await look.lookNow(hardId)
    await idle()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ enableThinking: false, thinkingBudget: undefined })
    expect(calls[1]).toMatchObject({ enableThinking: true, thinkingBudget: 1024, search: true })
    expect(calls[1].instructions).toBe(calls[0].instructions)
    expect(calls[1].text).toContain('[二次深度核查]')
    const hardSugg = await sugg.listSuggestions(hardId)
    expect(hardSugg.find((s) => s.kind === 'who')?.value).toBe('千雪')
    expect(hardSugg.find((s) => s.kind === 'src')?.value).toBe('https://example.com/p2')

    // 3. 本地有 WD 候选角色但初次 character 为空时触发深度思考；二次调用报错时优雅回退到初次有效结果
    const hintId = await createImage('hint-fallback.jpg', JSON.stringify({ revision: 'v1', tags: ['blue_hair'], characters: [{ name: 'ganyu', score: 0.72 }] }))
    calls.length = 0
    vi.mocked(searchCall)
      .mockImplementationOnce(async (meta) => {
        recordSearchCall(meta)
        return {
          text: '```json\n{"name":"蓝发少女","character":"","work":"","tags":["蓝发"],"source":"https://example.com/ok","description":"初次描述"}\n```',
          sources: [{ url: 'https://example.com/ok' }],
          usage: {}
        } as never
      })
      .mockImplementationOnce(async (meta) => {
        recordSearchCall(meta)
        throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })
      })
    await look.lookNow(hintId)
    await idle()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ enableThinking: true, thinkingBudget: 1024 })
    const hintSugg = await sugg.listSuggestions(hintId)
    expect(hintSugg.find((s) => s.kind === 'name')?.value).toBe('蓝发少女')
    expect(hintSugg.find((s) => s.kind === 'src')?.value).toBe('https://example.com/ok')
  })

  it('重新整理重看任务在第④层注入已有整理信息且保持 instructions 前缀不变', async () => {
    const { searchCall } = await import('../../src/main/services/ai/bailianClient')
    const { findExistingLookContext } = await import('../../src/main/repositories/aiResultRepository')
    const { pg } = getDatabase()
    const catDir = join(dir, 'category')
    mkdirSync(join(catDir, '原神', '甘雨'), { recursive: true })
    const catRootRes = await pg.query<{ id: number }>(
      `INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', 'category', $1) RETURNING id`,
      [catDir]
    )
    const catRootId = Number(catRootRes.rows[0].id)

    const reorgFile = join(source, 'reorg-test.jpg')
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 60, g: 90, b: 120 } } }).jpeg().toFile(reorgFile)
    const reorgHash = await hashFile(reorgFile)
    const imgRes = await pg.query<{ id: number }>(
      `INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18, display_name, source)
       VALUES ($1, 'JPG', 1, 800, 600, 1, 'GENERAL', 'MODEL', false, '旧名字', 'https://old.example/1') RETURNING id`,
      [reorgHash]
    )
    const reorgId = Number(imgRes.rows[0].id)
    await pg.query(`INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES ($1, 1, 'reorg-test.jpg', now())`, [reorgId])
    await pg.query(`INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES ($1, $2, '原神\\甘雨\\reorg-test.jpg', now())`, [reorgId, catRootId])
    await pg.query(
      `INSERT INTO image_tag (image_id, tag_id, source, status)
       SELECT $1, id, 'MANUAL', 'ACCEPTED' FROM tag WHERE name IN ('甘雨', '原神', '猫')`,
      [reorgId]
    )

    // R-18 图片绝不返回上下文
    expect(await findExistingLookContext(3)).toBeNull()
    expect(await findExistingLookContext(reorgId)).toEqual({
      displayName: '旧名字',
      source: 'https://old.example/1',
      characters: ['甘雨'],
      works: ['原神'],
      tags: ['猫'],
      categoryDir: '原神/甘雨'
    })

    // 先跑一次普通看图记录其 instructions 作为前缀基准
    calls.length = 0
    vi.mocked(searchCall).mockImplementation(async (meta) => {
      recordSearchCall(meta)
      return {
        text: '```json\n{"name":"修正后的名字","character":"刻晴","work":"原神","tags":["猫","紫发"],"source":"https://new.example/2","description":"修正描述"}\n```',
        sources: [{ url: 'https://new.example/2' }],
        usage: {}
      } as never
    })
    await look.lookNow(1)
    await idle()
    const baselineInstructions = calls[0].instructions

    calls.length = 0
    await pg.query(`INSERT INTO ai_job (kind, image_id, status, priority, payload) VALUES ('LOOK', $1, 'QUEUED', 10, '{"reorganize":true}'::jsonb)`, [reorgId])
    look.scheduleLook()
    await idle()

    expect(calls).toHaveLength(1)
    expect(calls[0].instructions).toBe(baselineInstructions)
    expect(calls[0].instructions).not.toContain('旧名字')
    expect(calls[0].text).toContain('[已有整理信息（仅供参考，其中可能有误，请结合画面重新独立核实并纠正）]')
    expect(calls[0].text).toContain('- 名字：旧名字')
    expect(calls[0].text).toContain('- 角色：甘雨')
    expect(calls[0].text).toContain('- 作品：原神')
    expect(calls[0].text).toContain('- 标签：猫')
    expect(calls[0].text).toContain('- 出处：https://old.example/1')
    expect(calls[0].text).toContain('- 当前类目录：原神/甘雨')

    const reorgSugg = await sugg.listSuggestions(reorgId)
    expect(reorgSugg.map((s) => `${s.kind}:${s.value}`)).toEqual([
      'name:修正后的名字',
      'tag:紫发',
      'who:刻晴',
      'src:https://new.example/2'
    ])
  })

  it('AI 建议单图重新识别：尾部排队不走批量、第④层注入反面参考、第 3 次起深度思考、原子替换且最多 5 次', async () => {
    const { searchCall } = await import('../../src/main/services/ai/bailianClient')
    const { pg } = getDatabase()
    const refreshFile = join(source, 'refresh-suggest.jpg')
    await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 110, b: 150 } } }).jpeg().toFile(refreshFile)
    const refreshHash = await hashFile(refreshFile)
    const inserted = await pg.query<{ id: number }>(
      `INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18)
       VALUES ($1, 'JPG', 1, 800, 600, 1, 'GENERAL', 'MODEL', false) RETURNING id`,
      [refreshHash]
    )
    const imgId = Number(inserted.rows[0].id)
    await pg.query(`INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES ($1, 1, 'refresh-suggest.jpg', now())`, [imgId])
    await pg.query(
      `INSERT INTO image_ai_result (image_id, kind, model, result, field_status) VALUES
       ($1, 'IDENTIFY', 'm', '{"name":"初版误判","character":"错角色","work":"错作品","tags":["旧标签"],"source":"https://old.example/wrong","description":"初版描述"}',
        '{"name":"PENDING","who":"PENDING","work":"PENDING","tag:旧标签":"PENDING","src":"PENDING"}'),
       ($1, 'ORGANIZE', 'm', '{"dir":"示例目录"}', '{"dir":"PENDING"}')`,
      [imgId]
    )

    // R-18 与未分级图均被拒绝
    await expect(look.refreshSuggestion(3)).rejects.toThrow('R-18')
    expect(await look.getSuggestionRefreshStatus(imgId)).toEqual({ refreshCount: 0, maxRefreshes: 5, active: false })

    // 先拍一次普通看图记录 instructions 基准
    calls.length = 0
    vi.mocked(searchCall).mockImplementation(async (meta) => {
      recordSearchCall(meta)
      return {
        text: '```json\n{"name":"第一轮结果","character":"刻晴","work":"原神","tags":["紫发"],"source":"https://example.com/r1","description":"第一轮描述"}\n```',
        sources: [{ url: 'https://example.com/r1' }],
        usage: {}
      } as never
    })
    await look.lookNow(1)
    await idle()
    const baselineInstructions = calls[0].instructions

    // 若本次重看请求失败（主请求与纯视觉降级均超时），原有待确认建议必须保留不被删除
    calls.length = 0
    vi.mocked(searchCall)
      .mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))
      .mockRejectedValueOnce(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))
    const failedSt = await look.refreshSuggestion(imgId)
    expect(failedSt).toEqual({ refreshCount: 1, maxRefreshes: 5, active: true })
    await idle()
    expect((await sugg.listSuggestions(imgId)).map((s) => `${s.kind}:${s.value}`)).toContain('name:初版误判')
    // 失败任务不计入已成功/排队的刷新次数
    expect(await look.getSuggestionRefreshStatus(imgId)).toEqual({ refreshCount: 0, maxRefreshes: 5, active: false })

    // 第 1 次有效刷新：带反面参考（不改 instructions）、原子替换旧 IDENTIFY 建议并保留 ORGANIZE
    calls.length = 0
    const beforeSuggested = suggested
    vi.mocked(searchCall).mockImplementation(async (meta) => {
      recordSearchCall(meta)
      return {
        text: '```json\n{"name":"第1次刷新","character":"刻晴","work":"原神","tags":["双马尾"],"source":"https://example.com/r1","description":"新描述"}\n```',
        sources: [{ url: 'https://example.com/r1' }],
        usage: {}
      } as never
    })
    const st1 = await look.refreshSuggestion(imgId)
    expect(st1).toEqual({ refreshCount: 1, maxRefreshes: 5, active: true })
    await idle()
    expect(calls).toHaveLength(1)
    expect(calls[0].instructions).toBe(baselineInstructions)
    expect(calls[0].enableThinking).toBe(false)
    expect(calls[0].text).toContain('[上一次识别结果（用户不满意，可能存在误判或漏判，仅作反面参考，切勿盲从，请独立重新观察画面并核实）]')
    expect(calls[0].text).toContain('- 名字：初版误判')
    expect(calls[0].text).toContain('- 角色：错角色')
    expect(suggested).toBeGreaterThan(beforeSuggested)

    const afterR1 = await sugg.listSuggestions(imgId)
    expect(afterR1.map((s) => `${s.kind}:${s.value}`)).toEqual([
      'name:第1次刷新',
      'tag:双马尾',
      'who:刻晴',
      'work:原神',
      'src:https://example.com/r1',
      'dir:示例目录'
    ])
    expect(await look.getSuggestionRefreshStatus(imgId)).toEqual({ refreshCount: 1, maxRefreshes: 5, active: false })

    // 第 2 次刷新：仍不强制思考
    calls.length = 0
    vi.mocked(searchCall).mockImplementation(async (meta) => {
      recordSearchCall(meta)
      return {
        text: '```json\n{"name":"第2次刷新","character":"刻晴","work":"原神","tags":["雷系"],"source":"","description":""}\n```',
        sources: [],
        usage: {}
      } as never
    })
    await look.refreshSuggestion(imgId)
    await idle()
    expect(calls[0].enableThinking).toBe(false)
    expect(calls[0].text).toContain('- 名字：第1次刷新')

    // 第 3 次刷新：直接开启深度思考 (enableThinking: true, thinkingBudget: 2048, search: true)，单次完成不二次升级
    for (const round of [3, 4, 5]) {
      calls.length = 0
      vi.mocked(searchCall).mockImplementation(async (meta) => {
        recordSearchCall(meta)
        return {
          text: `\`\`\`json\n{"name":"第${round}次刷新","character":"","work":"","tags":["深度核查"],"source":"","description":"","needs_thinking":true}\n\`\`\``,
          sources: [],
          usage: {}
        } as never
      })
      const st = await look.refreshSuggestion(imgId)
      expect(st).toEqual({ refreshCount: round, maxRefreshes: 5, active: true })
      await idle()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ enableThinking: true, thinkingBudget: 2048, search: true })
    }

    expect(await look.getSuggestionRefreshStatus(imgId)).toEqual({ refreshCount: 5, maxRefreshes: 5, active: false })
    // 超过 5 次上限后拒绝
    await expect(look.refreshSuggestion(imgId)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('网格与详情页重新识别遮罩（activeImageIds）仅针对已配密钥下的 refreshSuggestion / reorganize 任务，不含普通排队任务', async () => {
    const { aiJob } = await import('../../src/main/db/schema')
    const { db } = getDatabase()
    await db.delete(aiJob)
    await db.insert(aiJob).values([
      { kind: 'LOOK', status: 'QUEUED', imageId: 1, priority: 0, payload: null },
      { kind: 'LOOK', status: 'QUEUED', imageId: 2, priority: 5, payload: { reorganize: true } },
      { kind: 'LOOK', status: 'QUEUED', imageId: 3, priority: -1, payload: { refreshSuggestion: true } }
    ])
    const state = await look.getLookState()
    expect(state.activeImageIds).toEqual([2, 3])
    expect(state.activeImageIds).not.toContain(1)

    const prevKey = process.env.DASHSCOPE_API_KEY
    process.env.DASHSCOPE_API_KEY = ''
    try {
      const noKeyState = await look.getLookState()
      expect(noKeyState.needsApiKey).toBe(true)
      expect(noKeyState.activeImageIds).toEqual([])
    } finally {
      process.env.DASHSCOPE_API_KEY = prevKey
      await db.delete(aiJob)
    }
  })
})
