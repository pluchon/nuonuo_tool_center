import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_MARKDOWN_MAX_BYTES, type AiAskDTO } from '../../src/shared/api'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { routeLocally, routeTagRequest, type DictDir, type DictTag } from '../../src/main/services/ai/localRouter'

// 模型调用换成脚本：每次调用从队列里取一个预设的回复，并记下发出去的消息
const calls: Array<{ messages: unknown[]; tools: unknown[] }> = []
const script: Array<{ content?: string; tool_calls?: unknown[] }> = []
vi.mock('../../src/main/services/ai/embeddingClient', () => ({
  embed: vi.fn(async () => { throw new Error('测试向量服务不可用') })
}))
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async (input: { messages: unknown[]; tools: unknown[] }) => {
    calls.push({ messages: JSON.parse(JSON.stringify(input.messages)), tools: input.tools })
    const next = script.shift() ?? { content: '好的' }
    return { message: { role: 'assistant', content: next.content ?? '', tool_calls: next.tool_calls }, finishReason: 'stop', usage: {} }
  })
}))

const {
  answer,
  ask,
  deleteConversation,
  listConversations,
  listMessages,
  pinConversation,
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
    expect((calls[1].messages[1] as { content: string }).content).toContain(attachment.text)
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

  it('本地能完整对上的不调模型：R-18 关着不出现，开着排在后面', async () => {
    const first = await ask({ conversationId: null, text: '找甘雨的图', scope: null, includeR18: false })
    expect(first.conversation.title).toBe('找甘雨的图')
    const reply = await answer(first.conversation.id)
    expect(calls).toHaveLength(0)
    expect(reply.images.map((i) => i.name)).toEqual(['甘雨-好椰', '甘雨夜景'])
    expect(reply.how).toBe('搜索了图库：角色「甘雨」，找到 2 张')
    expect(reply.text).toBe('')

    await ask({ conversationId: first.conversation.id, text: '椰羊的竖图', scope: { kind: 'category', name: '二次元' }, includeR18: true })
    const r18 = await answer(first.conversation.id)
    expect(r18.images.map((i) => i.name)).toEqual(['甘雨-好椰', '甘雨私房'])
    expect(r18.how).toBe('搜索了图库：范围「二次元」，角色「甘雨」，方向「竖图」，找到 2 张')
  })

  it('对不上的进对话循环：工具往返，前缀固定，R-18 图只给数量', async () => {
    script.push(
      { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_images', arguments: '{"character":"椰羊","keywordGroups":[["夜景","晚上"]],"answerFromResults":true}' } }] },
      { content: '找到一张夜景，「甘雨夜景」。' }
    )
    const q = await ask({ conversationId: null, text: '甘雨在晚上的照片', scope: null, includeR18: true })
    const reply = await answer(q.conversation.id)
    expect(calls).toHaveLength(2)
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
    expect(String(firstMsgs[firstMsgs.length - 1].content)).toContain('包含 R-18')
    // 第二次请求：工具结果只给 R-18 的数量，不给名字
    const toolMsg = (calls[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('"r18Total":0')
    expect(toolMsg?.content).not.toContain('私房')
    expect(calls[0].tools).toEqual(calls[1].tools)

    // 下一轮：历史是上一轮的话和回复，最后一条历史打了标记；前缀和上一轮一致
    script.push({ content: '好的。' })
    await ask({ conversationId: q.conversation.id, text: '谢谢诺诺', scope: null, includeR18: false })
    await answer(q.conversation.id)
    const third = calls[2].messages as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(third[0])).toBe(JSON.stringify(firstMsgs[0]))
    expect(third.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(JSON.stringify(third[2].content)).toContain('ephemeral')
    expect(JSON.stringify(third[2].content)).not.toMatch(/#2|甘雨夜景|给用户看了/)
  })

  it('普通图和 R-18 命中均完整展示，历史按原开关和当前分级重新读取', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size) SELECT 'many-' || n, 'JPG', 1 FROM generate_series(1, 12) n;
      INSERT INTO image_tag (image_id, tag_id, source, status) SELECT id, 1, 'MANUAL', 'ACCEPTED' FROM image WHERE content_hash LIKE 'many-%';
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT id, 1, '二次元/' || content_hash || '.jpg', now() FROM image WHERE content_hash LIKE 'many-%';`)
    try {
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
    const q = await ask({ conversationId: null, text: '甘雨', scope: null, includeR18: true })
    expect((await answer(q.conversation.id)).images.map((i) => i.imageId)).toEqual([1, 2, 3])
    const { pg } = getDatabase()
    await pg.exec('UPDATE image SET is_r18 = true WHERE id = 1')
    try {
      await ask({ conversationId: q.conversation.id, text: '刚才第二张图叫什么？', scope: null, includeR18: true })
      script.push({ tool_calls: [{ id: 'g', type: 'function', function: { name: 'get_image', arguments: '{"position":2}' } }] }, { content: '叫甘雨夜景。' })
      expect((await answer(q.conversation.id)).text).toBe('叫甘雨夜景。')
      const sent = JSON.stringify(calls[1].messages)
      expect(sent).toContain('甘雨夜景')
      expect(sent).not.toContain('2=2')
      expect(sent).not.toMatch(/1=1|3=3|甘雨私房|甘雨-好椰/)

      await ask({ conversationId: q.conversation.id, text: '再看看刚才的图', scope: { kind: 'category', name: '其他目录' }, includeR18: true })
      script.push({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_image', arguments: '{"id":2}' } }] }, { content: '当前目录没有这张图。' })
      await answer(q.conversation.id)
      expect(JSON.stringify(calls[3].messages.filter((m) => (m as { role: string }).role === 'tool'))).toContain('没有这张图')
      expect(JSON.stringify(calls[2].messages)).not.toMatch(/2=2|甘雨夜景/)
    } finally {
      await pg.exec('UPDATE image SET is_r18 = false WHERE id = 1')
    }
  })

  it('remember 记下偏好；不认识的工具和坏参数返回错误给模型', async () => {
    script.push(
      {
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'remember', arguments: '{"content":"角色名用中文"}' } },
          { id: 'b', type: 'function', function: { name: 'delete_all', arguments: '{}' } },
          { id: 'c', type: 'function', function: { name: 'get_image', arguments: '{bad' } },
          { id: 'd', type: 'function', function: { name: 'get_image', arguments: '{"id":3}' } },
          { id: 'e', type: 'function', function: { name: 'list_tags', arguments: '{}' } }
        ]
      },
      { content: '记住啦。' }
    )
    const q = await ask({ conversationId: null, text: '以后角色名都用中文', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(reply.how).toBeNull()
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

  it('纯检索命中后直接返回卡片；云端出错报“网络异常”，这句话留着可以重试', async () => {
    script.push({ tool_calls: [{ id: 's', type: 'function', function: { name: 'search_images', arguments: '{"tags":["猫"]}' } }] })
    const q = await ask({ conversationId: null, text: '有没有毛茸茸的', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(calls).toHaveLength(1)
    expect(reply.text).toBe('')

    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    vi.mocked(chatCall).mockRejectedValueOnce(new Error('socket hang up'))
    const again = await ask({ conversationId: q.conversation.id, text: '再找找狗狗的', scope: null, includeR18: false })
    await expect(answer(again.conversation.id)).rejects.toThrow('网络异常')
    const msgs = await listMessages(q.conversation.id)
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', text: '再找找狗狗的' })
    script.push({ content: '没有狗狗的图。' })
    const fallback = await answer(q.conversation.id)
    expect(fallback).toMatchObject({ text: '没找到符合条件的图片。', images: [] })
    expect(fallback.how).toContain('找到 0 张')
    await expect(answer(q.conversation.id)).rejects.toThrow('没有要回复的话')
  })

  it('模糊检索缺少工具调用和数量时仍查库，同一句作为 Markdown 内容时保留模型答复', async () => {
    script.push({ content: '这几张都挺像的。' })
    const query = await ask({ conversationId: null, text: '帮我找落叶小猫的图片', scope: null, includeR18: false })
    expect((await answer(query.conversation.id)).images.map((i) => i.imageId)).toEqual([4])
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
      const q = await ask({ conversationId: null, text: '找标签为甘雨的图', scope, includeR18: false })
      expect((await answer(q.conversation.id)).images.map((item) => item.imageId)).toEqual([1, 2])
      await pg.exec("UPDATE image_file SET rel_path='其他/a.png' WHERE image_id=1 AND root_id=1")
      expect((await listMessages(q.conversation.id)).at(-1)?.images.map((item) => item.imageId)).toEqual([2])
      await expect(ask({ conversationId: null, text: '找图', scope: { kind: 'source', id: source.id } as unknown as AiAskDTO['scope'], includeR18: false })).rejects.toThrow('只能检索类目录')
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
})
