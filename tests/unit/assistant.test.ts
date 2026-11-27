import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { attachmentOriginal } from '../../src/main/repositories/aiConversationRepository'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_MARKDOWN_MAX_BYTES, type AiAskDTO, type AiReplyCacheUsage } from '../../src/shared/api'
import { normalizeChatUsage } from '../../src/main/services/ai/usage'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { PERSONA_FEW_SHOT_MESSAGES } from '../../src/main/services/ai/assistantPrompt'
import { routeLocally, routeTagRequest, type DictDir, type DictTag } from '../../src/main/services/ai/localRouter'

// 模型调用换成脚本：每次调用从队列里取一个预设的回复，并记下发出去的消息
const calls: Array<{ messages: unknown[]; tools: unknown[] }> = []
const script: Array<{ content?: string; tool_calls?: unknown[]; cacheUsage?: AiReplyCacheUsage }> = []
vi.mock('../../src/main/services/ai/embeddingClient', () => ({
  embed: vi.fn(async () => { throw new Error('测试向量服务不可用') })
}))
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async (input: { messages: unknown[]; tools: unknown[] }) => {
    calls.push({ messages: JSON.parse(JSON.stringify(input.messages)), tools: input.tools })
    const next = script.shift() ?? { content: '好的' }
    return { message: { role: 'assistant', content: next.content ?? '', tool_calls: next.tool_calls }, finishReason: 'stop', usage: {}, cacheUsage: next.cacheUsage }
  })
}))

const {
  abortAnswer,
  answer,
  ask,
  compactConversation,
  deleteConversation,
  editMessage,
  getRecalledDraft,
  isAnswering,
  listConversations,
  listMessages,
  pinConversation,
  recallMessage,
  renameConversation,
  suggestIdeas,
  undoDeleteConversation,
  voteMessage
} = await import('../../src/main/services/ai/assistantService')
const { ensureProfile } = await import('../../src/main/services/ai/profileService')

describe('本地路由', () => {
  const tags: DictTag[] = [
    { id: 1, name: '甘雨', aliases: ['椰羊'], category: '角色' },
    { id: 2, name: '原神', aliases: ['Genshin'], category: '作品' },
    { id: 3, name: '表情包', aliases: [], category: '主题' },
    { id: 4, name: '猫', aliases: [], category: '主题' }
  ]
  const dirs: DictDir[] = [{ rootId: 9, kind: 'SOURCE', name: '二次元' }]

  it('问句的壳子去掉后只剩标签、别名、目录和固定说法：本地回答', () => {
    expect(routeLocally('帮我找一下甘雨的表情包', tags, dirs)).toMatchObject({
      spec: { tagGroups: [[1], [3]], keywordGroups: [] },
      conds: [
        ['角色', '甘雨'],
        ['主题', '表情包']
      ]
    })
    expect(routeLocally('椰羊', tags, dirs)?.spec.tagGroups).toEqual([[1]])
    expect(routeLocally('genshin 的竖图', tags, dirs)?.spec).toMatchObject({ tagGroups: [[2]], orientation: 'portrait' })
    const r = routeLocally('二次元里还没打标签的图', tags, dirs)
    expect(r?.dirs).toEqual([dirs[0]])
    expect(r?.spec.untagged).toBe(true)
    expect(r?.conds[0]).toEqual(['范围', '二次元'])
    expect(routeLocally('最近导入的猫，要横的', tags, dirs)?.spec).toMatchObject({ recent: true, orientation: 'landscape', tagGroups: [[4]] })
  })

  it('有一个词对不上、或者什么都没对上：交给模型', () => {
    expect(routeLocally('秋天落叶里的猫', tags, dirs)).toBeNull()
    expect(routeLocally('帮我找找', tags, dirs)).toBeNull()
    expect(routeLocally('猫耳', tags, dirs)).toBeNull()
    expect(routeLocally('', tags, dirs)).toBeNull()
  })

  it('指定标签时只查完整标签名和别名，保留目录和方向，并允许零命中', () => {
    expect(routeTagRequest('找标签为猫娘的图', tags, dirs)?.spec.tagGroups).toEqual([[]])
    expect(routeTagRequest('按标签搜索 椰羊', tags, dirs)?.spec.tagGroups).toEqual([[1]])
    expect(routeTagRequest('找带有「Genshin」标签的图片', tags, dirs)?.spec.tagGroups).toEqual([[2]])
    expect(routeTagRequest('在二次元里找标签为椰羊或者猫、原神的横图', tags, dirs)).toMatchObject({
      spec: { orientation: 'landscape', tagGroups: [[1, 4], [2]], keywordGroups: [] }, dirs
    })
    expect(routeTagRequest('找标签为“苹果和梨”的图', tags, dirs)?.spec.tagGroups).toEqual([[]])
    for (const q of ['想看猫娘', '没打标签的图', '标签是什么意思', '如何管理标签', '帮我给甘雨加标签']) {
      expect(routeTagRequest(q, tags, dirs)).toBeNull()
    }
  })
})

describe('诺诺助手', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-assistant-'))
    const source = join(dir, 'pics')
    mkdirSync(source, { recursive: true })
    process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', '类目录', $1)`, [source])
    // 分类：1 角色、2 作品、4 主题、5 地点（迁移里建好的）
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, display_name, is_r18, thumb_ready, create_time) VALUES
        ('h1', 'PNG', 10, 100, 200, '甘雨-好椰', false, 1, now() - interval '1 day'),
        ('h2', 'JPG', 10, 200, 100, '甘雨夜景', false, 1, now() - interval '2 day'),
        ('h3', 'JPG', 10, 100, 200, '甘雨私房', true, 1, now() - interval '3 day'),
        ('h4', 'JPG', 10, 100, 100, '落叶小猫', false, 1, now() - interval '4 day');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
        (1, 1, '二次元/a.png', now()), (2, 1, '二次元/b.jpg', now()), (3, 1, '二次元/c.jpg', now()), (4, 1, '二次元/d.jpg', now());
      INSERT INTO tag (name, category_id) VALUES ('甘雨', 1), ('原神', 2), ('表情包', 4), ('猫', 4), ('京都', 5), ('只在R18', 4);
      INSERT INTO tag_alias (tag_id, name) VALUES (1, '椰羊');
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES
        (1, 1, 'MANUAL', 'ACCEPTED'), (1, 2, 'MANUAL', 'ACCEPTED'), (1, 3, 'MANUAL', 'ACCEPTED'),
        (2, 1, 'MANUAL', 'ACCEPTED'), (3, 1, 'MANUAL', 'ACCEPTED'), (3, 6, 'MANUAL', 'ACCEPTED'),
        (4, 4, 'MANUAL', 'ACCEPTED');
    `)
  })

  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  beforeEach(() => {
    calls.length = 0
    script.length = 0
  })

  it('按原始顺序解释标签命中，区分本轮排除和可忘记的长期排除', async () => {
    const params = { scope: null, includeR18: false }
    const pushSearchGanyu = () =>
      script.push(
        { tool_calls: [{ id: 'sg', type: 'function', function: { name: 'search_images', arguments: '{"tags":["甘雨"],"contrast":[]}' } }] },
        { content: '甘雨的图在这里啦~' }
      )
    pushSearchGanyu()
    const start = await ask({ ...params, conversationId: null, text: '找标签为甘雨的图' })
    const conversationId = start.conversation.id
    const original = await answer(conversationId)
    const ids = original.images.map((item) => item.imageId)
    expect(ids.slice().sort()).toEqual([1, 2])
    const next = async (text: string) => {
      await ask({ ...params, conversationId, text })
      return answer(conversationId)
    }
    expect((await next('第二张为什么符合条件？')).text).toContain('已确认的标签条件「甘雨」')
    expect((await next('这次排除第二张，以后照常')).images.map((item) => item.imageId)).toEqual(ids.slice(0, 1))
    pushSearchGanyu()
    expect((await next('找标签为甘雨的图')).images.map((item) => item.imageId)).toEqual(ids)
    try {
      await next('以后不要第二张')
      calls.length = 0
      pushSearchGanyu()
      const fresh = await ask({ ...params, conversationId: null, text: '找标签为甘雨的图' })
      expect((await answer(fresh.conversation.id)).images.map((item) => item.imageId)).toEqual(ids.slice(0, 1))
      const { excludedImageIds, removeImageExclusion } = await import('../../src/main/repositories/aiMemoryRepository')
      expect((await excludedImageIds()).has(ids[1])).toBe(true)
      expect((await getDatabase().pg.query("select 1 from ai_memory where content like '以后检索时排除图片 #%'")).rows).toHaveLength(0)
      await removeImageExclusion(ids[1])
      pushSearchGanyu()
      expect((await next('找标签为甘雨的图')).images.map((item) => item.imageId)).toEqual(ids)
    } finally {
      await getDatabase().pg.query('delete from ai_image_exclusion where image_id = $1', [ids[1]])
    }
  })

  it('只允许编辑末轮消息，并发和过期编辑只生成一份新记录', async () => {
    const params = { scope: null, includeR18: false }
    const first = await ask({ ...params, conversationId: null, text: '第一次提问' })
    const conversationId = first.conversation.id
    const firstReply = await answer(conversationId)
    const last = await ask({ ...params, conversationId, text: '第二次提问' })
    await answer(conversationId)
    await expect(recallMessage(conversationId, first.message.id)).rejects.toThrow('最后一条')
    await expect(editMessage(conversationId, last.message.id, ' ')).rejects.toThrow('说点什么')
    expect(await listMessages(conversationId)).toHaveLength(4)
    const results = await Promise.allSettled(['新问题', '重复操作'].map((text) => editMessage(conversationId, last.message.id, text)))
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    const edited = (await listMessages(conversationId)).at(-1)!
    expect(edited.text).toBe('新问题')
    await expect(recallMessage(conversationId, last.message.id)).rejects.toThrow('最后一条')
    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    vi.mocked(chatCall).mockRejectedValueOnce(new Error('socket hang up'))
    await expect(answer(conversationId)).rejects.toThrow()
    expect((await listMessages(conversationId)).map((m) => m.id)).toEqual([first.message.id, firstReply.id, edited.id])
    const pending = answer(conversationId)
    await expect(recallMessage(conversationId, edited.id)).rejects.toThrow('正在处理')
    const reply = await pending
    expect((await listMessages(conversationId)).map((m) => m.id)).toEqual([first.message.id, firstReply.id, edited.id, reply.id])
    expect(JSON.stringify(calls.at(-1)?.messages)).not.toContain('第二次提问')
    await recallMessage(conversationId, edited.id)
    expect((await listMessages(conversationId)).map((m) => m.id)).toEqual([first.message.id, firstReply.id])
    expect(await getRecalledDraft(conversationId)).toMatchObject({ text: '新问题' })
  })

  it('撤回后恢复附件、范围和 R-18 开关，重发复用原图哈希且只能提交一次', async () => {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#4c8acc' } }).png().toBuffer()
    const png = { kind: 'image' as const, name: '蓝.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }
    const md = { kind: 'markdown' as const, name: '提示.md', text: '# 观察颜色' }
    const scope = { kind: 'category' as const, name: '二次元' }
    const original = await ask({ conversationId: null, scope, includeR18: true, text: '', attachments: [md, png] })
    const conversationId = original.conversation.id
    const savedImage = async (id: number) => (await getDatabase().pg.query<{ image: { originalHash: string; dataUrl: string } }>(
      "select content->'attachments'->1 as image from ai_message where id = $1", [id]
    )).rows[0].image
    const stored = await savedImage(original.message.id)
    expect(stored.originalHash).toBeTruthy()
    expect(await attachmentOriginal(original.message.id)).toBe(png.dataUrl)
    const draft = await recallMessage(conversationId, original.message.id)
    expect(await listMessages(conversationId)).toEqual([])
    expect(await getRecalledDraft(conversationId)).toEqual(draft)
    expect(draft).toMatchObject({ scope, includeR18: true, attachments: [md, { kind: 'image', name: png.name }] })
    expect(draft.attachments[1]).not.toHaveProperty('originalHash')
    const resend = { ...draft, conversationId, text: '再看一次', recalledMessageId: draft.messageId }
    const other = await ask({ conversationId: null, scope: null, includeR18: false, text: '另一段对话' })
    await expect(ask({ ...resend, conversationId: other.conversation.id })).rejects.toThrow('草稿')
    const sent = await ask(resend)
    expect(await savedImage(sent.message.id)).toEqual(stored)
    expect(await attachmentOriginal(original.message.id)).toBeNull()
    expect(await attachmentOriginal(sent.message.id)).toBe(png.dataUrl)
    const archived = await getDatabase().pg.query('select hash from ai_image_original where hash = $1', [stored.originalHash])
    expect(archived.rows).toHaveLength(1)
    expect(await getRecalledDraft(conversationId)).toBeNull()
    await expect(ask(resend)).rejects.toThrow('草稿')
  })

  it('类目录没有可检索图片时说明归档条件，直接输入猫娘和完整问句都不调用模型', async () => {
    for (const text of ['猫娘', '有没有猫娘的图片']) {
      const q = await ask({ conversationId: null, text, scope: { kind: 'category', name: '空目录' }, includeR18: false })
      const reply = await answer(q.conversation.id)
      expect(reply.text).toContain('放进类目录')
      expect(reply.images).toEqual([])
      expect(reply.how).toBeNull()
    }
    expect(calls).toHaveLength(0)
  })

  it('只发 Markdown 仍可建立对话，附件正文和文件名在重试及追问中保留', async () => {
    const attachment = { kind: 'markdown' as const, name: 'landscape-prompt.MD', text: '# 提示词\n\n保留  缩进和 **粗体**。' }
    const q = await ask({ conversationId: null, text: '', scope: null, includeR18: false, attachment })
    expect(q.conversation.title).toBe(attachment.name)
    expect(q.message).toMatchObject({ attachment, text: '', image: null })
    expect((await listMessages(q.conversation.id))[0]).toEqual(q.message)
    const savedKey = process.env.DASHSCOPE_API_KEY
    try {
      process.env.DASHSCOPE_API_KEY = ' '
      await expect(answer(q.conversation.id)).rejects.toThrow('云端')
    } finally {
      process.env.DASHSCOPE_API_KEY = savedKey
    }
    expect(calls).toHaveLength(0)
    await answer(q.conversation.id)
    const first = calls[0].messages.at(-1) as { role: string; content: string }
    expect(first.role).toBe('user')
    expect(first.content).toContain(attachment.name)
    expect(first.content).toContain(attachment.text)
    expect((await listMessages(q.conversation.id)).map((m) => m.role)).toEqual(['user', 'assistant'])
    await ask({ conversationId: q.conversation.id, text: '解释文件的第一句', scope: null, includeR18: false })
    await answer(q.conversation.id)
    expect((calls[1].messages[1 + PERSONA_FEW_SHOT_MESSAGES.length] as { content: string }).content).toContain(attachment.text)
  })

  it('随 Markdown 提交的标签查询仍会将用户问题和文件正文一并传给模型', async () => {
    const q = await ask({
      conversationId: null, text: '找甘雨的图', scope: null, includeR18: false,
      attachment: { kind: 'markdown', name: '筛选条件.markdown', text: '\uFEFF只要夜景' }
    })
    await answer(q.conversation.id)
    expect(calls).toHaveLength(1)
    expect((calls[0].messages.at(-1) as { content: string }).content).toContain('找甘雨的图\n\n附件「筛选条件.markdown」\n只要夜景')
  })

  it('校验空文件、超长或二进制内容、异常文件名和损坏图片，拒绝时不创建对话', async () => {
    const dto = { conversationId: null, text: '', scope: null, includeR18: false }
    const count = (await listConversations()).length
    for (const [name, text] of [['empty.md', ' \r\n'], ['bad.md', '正文\x00'], ['bad.md', '\ud800'], ['x.md', '猫'.repeat(22000)], ['../x.md', '正文'], ['x.pdf', '正文']]) {
      await expect(ask({ ...dto, attachment: { kind: 'markdown', name, text } })).rejects.toThrow()
    }
    const image = { kind: 'image' as const, name: '场景.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YWJj' }
    await expect(ask({ ...dto, attachment: image })).rejects.toThrow('读不出来')
    await expect(ask({ ...dto, attachment: { ...image, mimeType: 'image/gif' } })).rejects.toThrow('类型')
    await expect(ask({ ...dto, attachment: image, image: image.dataUrl })).rejects.toThrow('附件')
    await expect(ask({ ...dto, attachment: 'invalid' } as unknown as AiAskDTO)).rejects.toThrow('附件')
    expect((await listConversations()).length).toBe(count)
    const limit = 'a'.repeat(AI_MARKDOWN_MAX_BYTES)
    const saved = await ask({ ...dto, attachment: { kind: 'markdown', name: '有效.md', text: limit } })
    expect(saved.message.attachment).toMatchObject({ text: limit })
    expect(calls).toHaveLength(0)
  })

  it('云端就绪时即使命中标签也走模型自然回答；离线降级才走本地快路径（R-18 关着不出现，开着排在后面）', async () => {
    script.push(
      { tool_calls: [{ id: 'g1', type: 'function', function: { name: 'search_images', arguments: '{"character":"甘雨","contrast":[]}' } }] },
      { content: '诺诺把甘雨的图都翻出来啦，快看看~' }
    )
    const first = await ask({ conversationId: null, text: '找甘雨的图', scope: null, includeR18: false })
    const reply = await answer(first.conversation.id)
    expect(calls).toHaveLength(2)
    expect(reply.images.map((i) => i.name)).toEqual(['甘雨-好椰', '甘雨夜景'])
    expect(reply.how).toBe('搜索了图库：角色「甘雨」，找到 2 张')
    expect(reply.text).toBe('诺诺把甘雨的图都翻出来啦，快看看~')

    const savedKey = process.env.DASHSCOPE_API_KEY
    process.env.DASHSCOPE_API_KEY = ' '
    try {
      await ask({ conversationId: first.conversation.id, text: '椰羊的竖图', scope: { kind: 'category', name: '二次元' }, includeR18: true })
      const r18 = await answer(first.conversation.id)
      expect(calls).toHaveLength(2)
      expect(r18.cacheUsage).toBeUndefined()
      expect(r18.images.map((i) => i.name)).toEqual(['甘雨-好椰', '甘雨私房'])
      expect(r18.how).toBe('搜索了图库：范围「二次元」，角色「甘雨」，方向「竖图」，找到 2 张')
      expect(r18.text).toBeTruthy()
      expect(r18.text).not.toMatch(/找到\s*\d|甘雨/)
    } finally {
      process.env.DASHSCOPE_API_KEY = savedKey
    }
  })

  it('对不上的进对话循环：工具往返，前缀固定，R-18 图只给数量，并保留诺诺自然口吻历史', async () => {
    script.push(
      { cacheUsage: { inputTokens: 100, cachedTokens: 0 }, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_images', arguments: '{"character":"椰羊","keywordGroups":[["夜景","晚上"]],"answerFromResults":true}' } }] },
      { content: '找到一张夜景，「甘雨夜景」。', cacheUsage: { inputTokens: 900, cachedTokens: 800 } }
    )
    const q = await ask({ conversationId: null, text: '甘雨在晚上的照片', scope: null, includeR18: true })
    const reply = await answer(q.conversation.id)
    expect(calls).toHaveLength(2)
    expect(reply.cacheUsage).toEqual({ inputTokens: 1000, cachedTokens: 800 })
    expect((await listMessages(q.conversation.id)).at(-1)?.cacheUsage).toEqual(reply.cacheUsage)
    expect(reply.text).toBe('找到一张夜景，「甘雨夜景」。')
    expect(reply.images.map((i) => i.name)).toEqual(['甘雨夜景'])
    // 关键词是“任一”：同义词里有一个对不上也能找到
    expect(reply.how).toBe('搜索了图库：角色「甘雨」，关键词「夜景、晚上」，找到 1 张')

    // 第一次请求：system 打了缓存标记，带着规则、档案和词表；第④层带时间和范围；没有历史
    const firstMsgs = calls[0].messages as Array<{ role: string; content: unknown }>
    expect(firstMsgs[0].role).toBe('system')
    const sys = JSON.stringify(firstMsgs[0].content)
    expect(sys).toContain('ephemeral')
    expect(sys).toContain('核心档案（第 1 版）')
    expect(sys).toContain('甘雨')
    // 只用在 R-18 图上的标签不进词表
    expect(sys).not.toContain('只在R18')
    expect(String(firstMsgs.at(-2)?.content)).toContain('包含 R-18')
    expect(firstMsgs.at(-1)?.content).toBe('甘雨在晚上的照片')
    // 第二次请求：工具结果只给 R-18 的数量，不给名字
    const toolMsg = (calls[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('"r18Total":0')
    expect(toolMsg?.content).not.toContain('私房')
    expect(calls[0].tools).toEqual(calls[1].tools)

    // 下一轮：历史保留诺诺实际说的话（不替换为模板文案），最后一条历史打了标记；前缀（含少样本语气示范）与上一轮字节一致
    script.push({ content: '哼，算你还有点眼光嘛～' })
    await ask({ conversationId: q.conversation.id, text: '谢谢诺诺', scope: null, includeR18: false })
    expect((await answer(q.conversation.id)).cacheUsage).toBeUndefined()
    const third = calls[2].messages as Array<{ role: string; content: unknown }>
    const prefixLen = 1 + PERSONA_FEW_SHOT_MESSAGES.length
    expect(JSON.stringify(third.slice(0, prefixLen))).toBe(JSON.stringify(firstMsgs.slice(0, prefixLen)))
    expect(third.map((m) => m.role)).toEqual([
      'system',
      ...PERSONA_FEW_SHOT_MESSAGES.map((m) => m.role),
      'user',
      'assistant',
      'system',
      'user'
    ])
    const lastHistoryMsg = third[prefixLen + 1]
    expect(JSON.stringify(lastHistoryMsg.content)).toContain('ephemeral')
    expect(JSON.stringify(lastHistoryMsg.content)).toContain('找到一张夜景，「甘雨夜景」。')
    expect(JSON.stringify(lastHistoryMsg.content)).not.toMatch(/#2|给用户看了/)
  })

  it('普通图和 R-18 命中均完整展示，历史按原开关和当前分级重新读取', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size) SELECT 'many-' || n, 'JPG', 1 FROM generate_series(1, 12) n;
      INSERT INTO image_tag (image_id, tag_id, source, status) SELECT id, 1, 'MANUAL', 'ACCEPTED' FROM image WHERE content_hash LIKE 'many-%';
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT id, 1, '二次元/' || content_hash || '.jpg', now() FROM image WHERE content_hash LIKE 'many-%';`)
    try {
      script.push(
        { tool_calls: [{ id: 'm1', type: 'function', function: { name: 'search_images', arguments: '{"character":"甘雨","contrast":[]}' } }] },
        { content: '甘雨都在这里啦~' },
        { tool_calls: [{ id: 'm2', type: 'function', function: { name: 'search_images', arguments: '{"tags":["表情包"],"contrast":[]}' } }] },
        { content: '表情包在这里~' }
      )
      const mixed = await ask({ conversationId: null, text: '甘雨', scope: null, includeR18: true })
      const results = await answer(mixed.conversation.id)
      expect(results.images).toHaveLength(15)
      expect(results.images.filter((i) => i.isR18).map((i) => i.imageId)).toEqual([3])
      const safe = await ask({ conversationId: null, text: '找表情包的图', scope: null, includeR18: false })
      expect((await answer(safe.conversation.id)).images.map((i) => i.imageId)).toEqual([1])
      await pg.exec('UPDATE image SET is_r18 = true WHERE id = 1')
      const hidden = (await listMessages(safe.conversation.id)).at(-1)
      expect(hidden).toMatchObject({ hasStoredResults: true, images: [], how: null, text: '这些图片目前不在检索范围内。' })
    } finally {
      await pg.exec("UPDATE image SET is_r18 = false WHERE id = 1; UPDATE image SET delete_state = 1 WHERE content_hash LIKE 'many-%'")
    }
  })

  it('旧对话复述的编号不能生成卡片或进入新一轮的模型上下文', async () => {
    const q = await ask({ conversationId: null, text: '查找白发', scope: null, includeR18: true })
    const legacy = '找到 100 张。（给用户看了 12 张图：#3「甘雨私房」）'
    await getDatabase().pg.query("INSERT INTO ai_message (conversation_id, role, content) VALUES ($1, 'ASSISTANT', $2)", [
      q.conversation.id, JSON.stringify({ text: legacy, how: null, imageIds: [], llm: legacy })
    ])
    expect((await listMessages(q.conversation.id)).at(-1)).toMatchObject({ text: '这条旧回复没有保存图片结果。', images: [] })
    await ask({ conversationId: q.conversation.id, text: '谢谢诺诺', scope: null, includeR18: false })
    await answer(q.conversation.id)
    expect(JSON.stringify(calls[0].messages)).not.toMatch(/给用户看了|甘雨私房/)
  })

  it('按显示顺序追问时遵守本轮范围和最新分级，只向模型提供可读普通图的编号', async () => {
    script.push(
      { tool_calls: [{ id: 'g2', type: 'function', function: { name: 'search_images', arguments: '{"character":"甘雨","contrast":[]}' } }] },
      { content: '甘雨的三张图都找到啦~' }
    )
    const q = await ask({ conversationId: null, text: '甘雨', scope: null, includeR18: true })
    expect((await answer(q.conversation.id)).images.map((i) => i.imageId)).toEqual([1, 2, 3])
    const { pg } = getDatabase()
    await pg.exec('UPDATE image SET is_r18 = true WHERE id = 1')
    try {
      calls.length = 0
      await ask({ conversationId: q.conversation.id, text: '刚才第二张图叫什么？', scope: null, includeR18: true })
      expect((await answer(q.conversation.id)).text).toContain('甘雨夜景')
      expect(calls).toHaveLength(0)

      await ask({ conversationId: q.conversation.id, text: '再看看刚才的图', scope: { kind: 'category', name: '其他目录' }, includeR18: true })
      script.push({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_image', arguments: '{"id":2}' } }] }, { content: '当前目录没有这张图。' })
      await answer(q.conversation.id)
      expect(JSON.stringify(calls[1].messages.filter((m) => (m as { role: string }).role === 'tool'))).toContain('没有这张图')
      expect(JSON.stringify(calls[0].messages)).not.toMatch(/2=2/)
    } finally {
      await pg.exec('UPDATE image SET is_r18 = false WHERE id = 1')
    }
  })

  it('查询标签后连续闲聊保持图片身份，改为受限后不再发送旧图片元数据；关闭 R-18 时脱敏开启 R-18 时的读取记录', async () => {
    const base = { scope: null, includeR18: false }
    const start = await ask({ ...base, conversationId: null, text: '这张图有哪些已确认的标签？',
      references: [{ imageId: 2, position: 1, name: '', groupId: 'gallery:focus' }] })
    const id = start.conversation.id
    expect((await answer(id)).text).toContain('甘雨夜景')
    const follow = async (text: string, includeR18 = false) => {
      await ask({ scope: null, includeR18, conversationId: id, text })
      script.push({ content: '这张画的夜色挺有趣。' })
      await answer(id)
      return JSON.stringify(calls.at(-1)?.messages)
    }
    const first = await follow('是不是很有趣呢？')
    expect(first).toContain('这张图有哪些已确认的标签')
    expect(first).toContain('甘雨夜景')
    expect(first).not.toContain('data:image')
    script.push({ content: '用户引用了一张图库图片并询问标签。' })
    expect((await compactConversation(id)).changed).toBe(true)
    expect(await follow('这个图片')).toContain('这张画的夜色挺有趣')
    expect(await follow('之前给你发的那一张')).toContain('甘雨夜景')
    const { pg } = getDatabase()
    await pg.exec('update image set is_r18=true where id=2')
    try {
      expect(await follow('再聊一句')).not.toContain('甘雨夜景')
    } finally { await pg.exec('update image set is_r18=false where id=2') }

    // 若上轮在 includeR18=true 时调用 get_image 读取单图元数据，切回 includeR18=false 时历史回复须脱敏
    await ask({ scope: null, includeR18: true, conversationId: id, text: '看看图3详情' })
    script.push(
      { tool_calls: [{ id: 'gi3', type: 'function', function: { name: 'get_image', arguments: '{"id":3}' } }] },
      { content: '这张「甘雨私房」有只在R18标签。' }
    )
    await answer(id)
    const afterR18Off = await follow('切回普通聊天啦', false)
    expect(afterR18Off).not.toContain('甘雨私房')
    expect(afterR18Off).toContain('（本轮围绕图库图片作了回答。）')
  })

  it('图库引用按组保留原序，只比较已确认标签，撤回和重发保持图片身份', async () => {
    const ref = (imageId: number, position: number, groupId = 'gallery:fixture') => ({ imageId, position, groupId, name: '过期图名' })
    const params = { scope: null, includeR18: false }
    const q = await ask({ ...params, conversationId: null, text: '比较这几张图片的共同标签',
      references: [ref(3, 1), ref(1, 2), ref(3, 3), ref(2, 2, 'gallery:another')] })
    const id = q.conversation.id
    expect(q.message.references?.map((r) => r.imageId)).toEqual([3, 1, 2])
    expect(q.message.references?.map((r) => r.name)).not.toContain('过期图名')
    expect((await answer(id)).text).toBe('共同标签：甘雨。')
    await ask({ ...params, conversationId: id, text: '第一组第二张图叫什么？' })
    expect((await answer(id)).text).toContain('甘雨-好椰')
    await ask({ ...params, conversationId: id, text: '第二组第二张有哪些标签？' })
    expect((await answer(id)).text).toContain('甘雨夜景')
    expect(calls).toHaveLength(0)
    const direct = await ask({ ...params, conversationId: id, text: '解释这张图片', references: [ref(3, 1)] })
    expect((await answer(id)).text).toContain('本地')
    expect(calls).toHaveLength(0)
    const edit = await editMessage(id, direct.message.id, '这张图片有哪些已确认的标签？')
    expect(edit.references).toEqual(direct.message.references)
    expect((await answer(id)).text).toContain('只在R18')
    const draft = await recallMessage(id, edit.id)
    expect(draft.references).toEqual(edit.references)
    const again = await ask({ ...params, conversationId: id, text: draft.text, references: draft.references, recalledMessageId: draft.messageId })
    expect(again.message.references).toEqual(draft.references)
    await expect(ask({ ...params, conversationId: id, text: '无效来源', references:
      [{ ...ref(1, 1), sourceMessageId: q.message.id, groupId: 'result:' + q.message.id }] })).rejects.toThrow('结果已经变更')
    await ask({ ...params, includeR18: true, conversationId: id, text: '找标签为甘雨的图' })
    script.push(
      { tool_calls: [{ id: 'sg2', type: 'function', function: { name: 'search_images', arguments: '{"tags":["甘雨"],"contrast":[]}' } }] },
      { content: '找到了甘雨的图~' }
    )
    const result = await answer(id)
    calls.length = 0
    const fromResult = (imageId: number, position: number) =>
      ({ ...ref(imageId, position, 'result:' + result.id), sourceMessageId: result.id })
    const normal = { ...params, conversationId: id, text: '第二张图叫什么？' }
    await expect(ask({ ...normal, includeR18: true, references: [fromResult(2, 1)] })).rejects.toThrow('范围已经变更')
    await expect(ask({ ...normal, references: [fromResult(3, 3)] })).rejects.toThrow('范围已经变更')
    await expect(ask({ ...normal, scope: { kind: 'category', name: '未选择的目录' },
      references: [fromResult(2, 2)] })).rejects.toThrow('范围已经变更')
    await ask({ ...normal, references: [fromResult(2, 2)] })
    expect((await answer(id)).text).toContain('甘雨夜景')
    expect(calls).toHaveLength(0)
    const mixed = await ask({ ...params, conversationId: null, references: [ref(3, 1), ref(2, 2)], text: '给这幅画起一个名字，并说说为什么会出现彩虹' })
    script.push({ content: '夜色中的甘雨。' })
    await answer(mixed.conversation.id)
    expect(calls).toHaveLength(1)
    const sent = JSON.stringify(calls[0].messages)
    expect(sent).toContain('甘雨夜景')
    expect(sent).not.toMatch(/甘雨私房|只在R18|data:image|image_url/)
    await ask({ ...params, includeR18: true, conversationId: mixed.conversation.id,
      text: '看看第二张的配色', references: [ref(3, 1), ref(2, 2)] })
    script.push({ tool_calls: [
      { id: 's', type: 'function', function: { name: 'search_images', arguments: '{"character":"甘雨"}' } },
      { id: 'g', type: 'function', function: { name: 'get_image', arguments: '{"id":3}' } }
    ] }, { content: '参考图中的角色是甘雨。' })
    const restricted = await answer(mixed.conversation.id)
    expect(restricted.images.map((r) => r.imageId)).toEqual([2])
    const scoped = JSON.stringify(calls.at(-1)?.messages)
    expect(scoped).toContain('甘雨夜景')
    expect(scoped).not.toMatch(/甘雨-好椰|甘雨私房|只在R18/)
  })

  it('remember 记下偏好；不认识的工具和坏参数返回错误给模型', async () => {
    script.push(
      {
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'remember', arguments: '{"content":"角色名用中文","evidence":"以后角色名都用中文"}' } },
          { id: 'b', type: 'function', function: { name: 'delete_all', arguments: '{}' } },
          { id: 'c', type: 'function', function: { name: 'get_image', arguments: '{bad' } },
          { id: 'd', type: 'function', function: { name: 'get_image', arguments: '{"id":3}' } },
          { id: 'e', type: 'function', function: { name: 'list_tags', arguments: '{}' } }
        ]
      },
      { content: '记住啦。', cacheUsage: { inputTokens: 100, cachedTokens: 90 } }
    )
    const q = await ask({ conversationId: null, text: '以后角色名都用中文', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(reply.how).toBeNull()
    expect(reply.cacheUsage).toBeUndefined()
    const tools = (calls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content)
    expect(tools[0]).toBe('{"ok":true}')
    expect(tools[1]).toContain('没有 delete_all')
    expect(tools[2]).toContain('JSON')
    expect(tools[3]).toBe('{"error":"没有这张图"}')
    expect(tools[4]).not.toContain('只在R18')
    const { pg } = getDatabase()
    const mem = await pg.query<{ content: string }>(`SELECT content FROM ai_memory`)
    expect(mem.rows.map((r) => r.content)).toEqual(['角色名用中文'])
  })

  it('检索命中后由模型自然作答；云端出错报“网络异常”，这句话留着可以重试', async () => {
    script.push(
      { tool_calls: [{ id: 's', type: 'function', function: { name: 'search_images', arguments: '{"tags":["猫"],"onMatch":"耳朵竖好，给你看喵 ฅ^•ﻌ•^ฅ"}' } }] },
      { content: '耳朵竖好，给你看喵 ฅ^•ﻌ•^ฅ' }
    )
    const q = await ask({ conversationId: null, text: '有没有毛茸茸的', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(calls).toHaveLength(2)
    expect(reply.text).toBe('耳朵竖好，给你看喵 ฅ^•ﻌ•^ฅ')

    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    vi.mocked(chatCall).mockRejectedValueOnce(new Error('socket hang up'))
    const again = await ask({ conversationId: q.conversation.id, text: '再找找狗狗的', scope: null, includeR18: false })
    await expect(answer(again.conversation.id)).rejects.toThrow('网络异常')
    const msgs = await listMessages(q.conversation.id)
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', text: '再找找狗狗的' })
    script.push(
      { tool_calls: [{ id: 'retry', type: 'function', function: { name: 'search_images', arguments: '{"semantic":"狗狗"}' } }] },
      { content: '' }
    )
    const fallback = await answer(q.conversation.id)
    expect(fallback).toMatchObject({ text: '目前只完成了部分检索。', images: [] })
    expect(fallback.how).toContain('目前显示 0 张，画面相似度检索暂不可用')
    await expect(answer(q.conversation.id)).rejects.toThrow('没有要回复的话')
  })

  it('补充视觉对照时断线，仍返回已匹配的标签卡片', async () => {
    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    vi.mocked(chatCall).mockResolvedValueOnce({
      message: { role: 'assistant', content: '', refusal: null, tool_calls: [{
        id: 'partial', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['甘雨'], semantic: '甘雨' }) }
      }] }, finishReason: 'tool_calls', usage: normalizeChatUsage({})
    }).mockRejectedValueOnce(new Error('socket hang up'))
    const q = await ask({ conversationId: null, text: '找一幅椰羊在林间的画', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(reply.images.map((i) => i.imageId).sort()).toEqual([1, 2])
    expect(reply.how).toContain('目前显示 2 张，画面相似度检索暂不可用')
  })

  it('模型用结构化工具找图，普通对话和 Markdown 正文中的搜索词不触发检索', async () => {
    script.push({ tool_calls: [{ id: 'find', type: 'function', function: { name: 'search_images', arguments: '{"keywordGroups":[["落叶小猫"]]}' } }] })
    const query = await ask({ conversationId: null, text: '帮我找落叶小猫的图片', scope: null, includeR18: false })
    expect((await answer(query.conversation.id)).images.map((i) => i.imageId)).toEqual([4])
    for (const question of ['你最喜欢什么', '为什么会出现彩虹', '帮我找出这句话的语病', '你会创建类目录吗', '聊聊把类目录 A 移动到 B 的利弊', '猫']) {
      const content = '我找到了两张纸，画在上面讲给你听。'
      script.push({ content })
      await ask({ conversationId: query.conversation.id, text: question, scope: null, includeR18: false })
      expect(await answer(query.conversation.id)).toMatchObject({ text: content, images: [], how: null })
      expect(JSON.stringify(calls.at(-1)?.messages)).not.toContain('已查询图库。')
    }
    script.push({ content: '找到 2 张。' })
    const file = await ask({ conversationId: null, text: '找出下面句子', scope: null, includeR18: false,
      attachment: { kind: 'markdown', name: '原文.md', text: '请原样复述：找到 2 张。' } })
    expect(await answer(file.conversation.id)).toMatchObject({ text: '找到 2 张。', images: [], how: null })
  })

  it('对话记录：重命名、置顶排在前面、删除可撤销、赞踩', async () => {
    const list = await listConversations()
    const last = list[list.length - 1]
    await renameConversation(last.id, '  甘雨合集 ')
    await pinConversation(last.id, true)
    const pinned = await listConversations()
    expect(pinned[0]).toMatchObject({ id: last.id, title: '甘雨合集', pinned: true })
    await expect(renameConversation(last.id, '   ')).rejects.toThrow()

    await deleteConversation(last.id)
    expect((await listConversations()).some((c) => c.id === last.id)).toBe(false)
    await expect(listMessages(last.id)).rejects.toThrow('不在')
    await undoDeleteConversation(last.id)
    expect((await listConversations()).some((c) => c.id === last.id)).toBe(true)

    const msgs = await listMessages(last.id)
    const replyId = msgs.find((m) => m.role === 'assistant')!.id
    await voteMessage(replyId, 'UP')
    expect((await listMessages(last.id)).find((m) => m.id === replyId)?.vote).toBe('UP')
    await voteMessage(replyId, null)
    await expect(voteMessage(msgs[0].id, 'DOWN')).rejects.toThrow()
    await expect(ask({ conversationId: null, text: '   ', scope: null, includeR18: false })).rejects.toThrow()
  })

  it('源图和类目录副本共存时，仅类目录文件名、卡片路径及当前仍存在的归档位置可检索', async () => {
    const { pg } = getDatabase()
    const { searchImages, findImageBrief, findDirNames } = await import('../../src/main/repositories/aiSearchRepository')
    const { rows: [source] } = await pg.query<{ id: number }>("INSERT INTO library_root(kind,name,path) VALUES ('SOURCE','待整理','/only-source') RETURNING id")
    const { rows: [only] } = await pg.query<{ id: number }>("INSERT INTO image(content_hash,format,byte_size,display_name) VALUES ('source-only','PNG',1,'仅在源目录') RETURNING id")
    try {
      await pg.query("INSERT INTO image_tag(image_id,tag_id,status,source) VALUES ($1,1,'ACCEPTED','MANUAL')", [only.id])
      await pg.query("INSERT INTO image_file(image_id,root_id,rel_path,mtime) VALUES ($1,$2,'待整理.png',now()), (1,$2,'源文件特有名.png',now())", [only.id, source.id])
      expect(await findDirNames()).not.toContainEqual(expect.objectContaining({ name: '待整理' }))
      expect((await searchImages({ r18: 'exclude', tagGroups: [], keywordGroups: [['源文件特有名']] })).ids).toEqual([])
      expect(await findImageBrief(only.id, { dirs: undefined })).toBeUndefined()
      const scope = { kind: 'category' as const, name: '二次元' }
      script.push(
        { tool_calls: [{ id: 'sg3', type: 'function', function: { name: 'search_images', arguments: '{"tags":["甘雨"],"contrast":[]}' } }] },
        { content: '二次元目录下的甘雨图都在这里了~' }
      )
      const q = await ask({ conversationId: null, text: '找标签为甘雨的图', scope, includeR18: false })
      expect((await answer(q.conversation.id)).images.map((item) => item.imageId)).toEqual([1, 2])
      await pg.exec("UPDATE image_file SET rel_path='其他/a.png' WHERE image_id=1 AND root_id=1")
      expect((await listMessages(q.conversation.id)).at(-1)?.images.map((item) => item.imageId)).toEqual([2])
      await expect(ask({ conversationId: null, text: '找图', scope: { kind: 'source', id: source.id } as unknown as AiAskDTO['scope'], includeR18: false })).rejects.toThrow('只能检索类目录')

      // 指定嵌套类目录路径、按类目录过滤 list_tags、直接列出类目录内图片（含 includeR18 元数据可读与开关隔离）
      await pg.exec("UPDATE image_file SET rel_path='二次元/精选/a.png' WHERE image_id=1 AND root_id=1")
      const nestedQ = await ask({ conversationId: null, text: '列出这个目录的图', scope: { kind: 'category', name: '二次元\\精选\\' }, includeR18: false })
      expect(nestedQ.message.scope).toEqual({ kind: 'category', name: '二次元/精选' })
      script.push(
        { tool_calls: [
          { id: 't1', type: 'function', function: { name: 'list_tags', arguments: '{}' } },
          { id: 's1', type: 'function', function: { name: 'search_images', arguments: '{"browseScope":true,"contrast":[]}' } }
        ] },
        { content: '这里面有甘雨-好椰。' }
      )
      const nestedReply = await answer(nestedQ.conversation.id)
      expect(nestedReply.images.map((item) => item.imageId)).toEqual([1])
      const nestedTools = (calls.at(-1)?.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content)
      expect(nestedTools[0]).toContain('甘雨')
      expect(nestedTools[0]).not.toContain('只在R18')
      expect(nestedTools[1]).toContain('甘雨-好椰')

      // 开启 includeR18 后可读取 R-18 图片的名称与已确认标签元数据，且绝不附带像素
      const r18MetaQ = await ask({ conversationId: null, text: '查看只在R18标签和细节', scope: { kind: 'category', name: '二次元' }, includeR18: true })
      script.push(
        { tool_calls: [
          { id: 'lt', type: 'function', function: { name: 'list_tags', arguments: '{}' } },
          { id: 'sr', type: 'function', function: { name: 'search_images', arguments: '{"tags":["只在R18"],"contrast":[]}' } },
          { id: 'gi', type: 'function', function: { name: 'get_image', arguments: '{"id":3}' } }
        ] },
        { content: '这张是「甘雨私房」，包含标签：甘雨、只在R18。' }
      )
      const r18MetaReply = await answer(r18MetaQ.conversation.id)
      expect(r18MetaReply.images.map((item) => item.imageId)).toEqual([3])
      const r18Tools = (calls.at(-1)?.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content)
      expect(JSON.parse(r18Tools[0])).toContainEqual(expect.objectContaining({ name: '只在R18' }))
      expect(JSON.parse(r18Tools[1])).toMatchObject({ total: 1, images: [expect.objectContaining({ id: 3, name: '甘雨私房', isR18: true })] })
      expect(JSON.parse(r18Tools[2])).toMatchObject({ id: 3, name: '甘雨私房', tags: ['甘雨', '只在R18'], isR18: true, description: '' })
      expect(JSON.stringify(calls.at(-1)?.messages)).not.toMatch(/data:image|image_url/)
    } finally {
      await pg.exec("UPDATE image_file SET rel_path='二次元/a.png' WHERE image_id=1 AND root_id=1")
      await pg.query("UPDATE library_root SET delete_state=1 WHERE id=$1", [source.id])
      await pg.query("UPDATE image SET delete_state=1 WHERE id=$1", [only.id])
    }
  })

  it('示例问题：只用非 R-18 图上的词，最多四个不重复；档案词表没变时不出新版本', async () => {
    let seed = 1
    const ideas = await suggestIdeas(() => ((seed = (seed * 9301 + 49297) % 233280), seed / 233280))
    expect(ideas.length).toBeGreaterThan(0)
    expect(ideas.length).toBeLessThanOrEqual(4)
    expect(new Set(ideas).size).toBe(ideas.length)
    expect(ideas.join('')).not.toContain('只在R18')
    expect((await ensureProfile()).version).toBe(1)
    expect((await ensureProfile(new Date(Date.now() + 3 * 24 * 3600 * 1000))).version).toBe(1)
  })

  it('abortAnswer 可中断正在进行的回答，持久化 interrupted 与已获取的缓存用量并立即释放对话锁', async () => {
    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    let notifyEntered!: () => void
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve })
    vi.mocked(chatCall)
      .mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: '先查查看',
          refusal: null,
          tool_calls: [{ id: 'ab1', type: 'function', function: { name: 'search_images', arguments: '{"tags":["甘雨"],"contrast":[]}' } }]
        },
        finishReason: 'tool_calls',
        usage: normalizeChatUsage({}),
        cacheUsage: { inputTokens: 120, cachedTokens: 60 }
      })
      .mockImplementationOnce(async (input) => {
        notifyEntered()
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
          if (input.signal?.aborted) onAbort()
          else input.signal?.addEventListener('abort', onAbort, { once: true })
        })
      })

    const q = await ask({ conversationId: null, text: '找标签为甘雨的图', scope: null, includeR18: false })
    const pending = answer(q.conversation.id)
    await entered
    expect(isAnswering()).toBe(true)

    expect(await abortAnswer(q.conversation.id)).toBe(true)
    expect(isAnswering()).toBe(false)

    const reply = await pending
    expect(reply.interrupted).toBe(true)
    expect(reply.cacheUsage).toEqual({ inputTokens: 120, cachedTokens: 60 })
    expect(reply.images.map((i) => i.imageId).sort()).toEqual([1, 2])
    expect(reply.blocks).toEqual([
      { type: 'narration', text: '先查查看' },
      { type: 'action', id: 's0-0-ab1', tool: 'search_images', summary: '检索图库：甘雨 · 2 张', status: 'done' }
    ])

    script.push({ content: '好哒，直接继续~' })
    await ask({ conversationId: q.conversation.id, text: '换句话聊聊', scope: null, includeR18: false })
    expect((await answer(q.conversation.id)).text).toBe('好哒，直接继续~')
  })
})
