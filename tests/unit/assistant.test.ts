import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { routeLocally, type DictDir, type DictTag } from '../../src/main/services/ai/localRouter'

// 模型调用换成脚本：每次调用从队列里取一个预设的回复，并记下发出去的消息
const calls: Array<{ messages: unknown[]; tools: unknown[] }> = []
const script: Array<{ content?: string; tool_calls?: unknown[] }> = []
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
      spec: { tagGroups: [[1], [3]], keywords: [] },
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
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', '二次元', $1)`, [source])
    // 分类：1 角色、2 作品、4 主题、5 地点（迁移里建好的）
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, display_name, is_r18, thumb_ready, create_time) VALUES
        ('h1', 'PNG', 10, 100, 200, '甘雨-好椰', false, 1, now() - interval '1 day'),
        ('h2', 'JPG', 10, 200, 100, '甘雨夜景', false, 1, now() - interval '2 day'),
        ('h3', 'JPG', 10, 100, 200, '甘雨私房', true, 1, now() - interval '3 day'),
        ('h4', 'JPG', 10, 100, 100, '落叶小猫', false, 1, now() - interval '4 day');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
        (1, 1, 'a.png', now()), (2, 1, 'b.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.jpg', now());
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

  it('本地能完整对上的不调模型：R-18 关着不出现，开着排在后面', async () => {
    const first = await ask({ conversationId: null, text: '找甘雨的图', scope: null, includeR18: false })
    expect(first.conversation.title).toBe('找甘雨的图')
    const reply = await answer(first.conversation.id)
    expect(calls).toHaveLength(0)
    expect(reply.images.map((i) => i.name)).toEqual(['甘雨-好椰', '甘雨夜景'])
    expect(reply.how).toBe('搜索了图库：角色「甘雨」，找到 2 张')
    expect(reply.text).toBe('找到 2 张。没有算上 R-18 图。')

    await ask({ conversationId: first.conversation.id, text: '椰羊的竖图', scope: { kind: 'source', id: 1 }, includeR18: true })
    const r18 = await answer(first.conversation.id)
    expect(r18.images.map((i) => i.name)).toEqual(['甘雨-好椰', '甘雨私房'])
    expect(r18.how).toBe('搜索了图库：范围「二次元」，角色「甘雨」，方向「竖图」，找到 2 张')
  })

  it('对不上的进对话循环：工具往返，前缀固定，R-18 图只给数量', async () => {
    script.push(
      { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_images', arguments: '{"character":"椰羊","keywords":["夜景","晚上"]}' } }] },
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
    expect(JSON.stringify(third[2].content)).toContain('#2「甘雨夜景」')
  })

  it('remember 记下偏好；不认识的工具和坏参数返回错误给模型', async () => {
    script.push(
      {
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'remember', arguments: '{"content":"角色名用中文"}' } },
          { id: 'b', type: 'function', function: { name: 'delete_all', arguments: '{}' } },
          { id: 'c', type: 'function', function: { name: 'get_image', arguments: '{bad' } },
          { id: 'd', type: 'function', function: { name: 'get_image', arguments: '{"id":3}' } }
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
    expect(tools[3]).toBe('{"id":3,"r18":true}')
    const { pg } = getDatabase()
    const mem = await pg.query<{ content: string }>(`SELECT content FROM ai_memory`)
    expect(mem.rows.map((r) => r.content)).toEqual(['角色名用中文'])
  })

  it('模型一直调工具：步数用完给模板回复；云端出错报“网络异常”，这句话留着可以重试', async () => {
    for (let i = 0; i < 4; i++) {
      script.push({ tool_calls: [{ id: `s${i}`, type: 'function', function: { name: 'search_images', arguments: '{"tags":["猫"]}' } }] })
    }
    const q = await ask({ conversationId: null, text: '有没有毛茸茸的', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(calls).toHaveLength(4)
    expect(reply.text).toBe('找到 1 张。没有算上 R-18 图。')

    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    vi.mocked(chatCall).mockRejectedValueOnce(new Error('socket hang up'))
    const again = await ask({ conversationId: q.conversation.id, text: '再找找狗狗的', scope: null, includeR18: false })
    await expect(answer(again.conversation.id)).rejects.toThrow('网络异常')
    const msgs = await listMessages(q.conversation.id)
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user', text: '再找找狗狗的' })
    script.push({ content: '没有狗狗的图。' })
    expect((await answer(q.conversation.id)).text).toBe('没有狗狗的图。')
    await expect(answer(q.conversation.id)).rejects.toThrow('没有要回复的话')
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
