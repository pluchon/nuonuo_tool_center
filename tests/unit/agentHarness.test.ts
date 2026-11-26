import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { microcompactTail } from '../../src/main/services/ai/harness/context'
import { defineTool, dispatchTool, validateToolArgs } from '../../src/main/services/ai/harness/toolRegistry'
import { createInitialHarnessState, reduceToolOutcome } from '../../src/main/services/ai/harness/types'
import { evaluateVisualTags, normalizeVisualTags } from '../../src/main/services/ai/search/visualMatcher'

const calls: Array<{ messages: unknown[]; tools: unknown[]; enableThinking?: boolean; thinkingBudget?: number }> = []
type ScriptedTurn = {
  content?: string
  tool_calls?: unknown[]
  reasoningContent?: string
  onCall?: (input: { signal?: AbortSignal; onDelta?: (delta: string) => void }) => Promise<{
    content?: string
    tool_calls?: unknown[]
    reasoningContent?: string
  }>
}
const script: ScriptedTurn[] = []
vi.mock('../../src/main/services/ai/embeddingClient', () => ({
  embed: vi.fn(async () => {
    throw new Error('测试向量服务不可用')
  })
}))
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async (input?: {
    messages?: unknown[]
    tools?: unknown[]
    enableThinking?: boolean
    thinkingBudget?: number
    signal?: AbortSignal
    onDelta?: (delta: string) => void
  }) => {
    calls.push({
      messages: JSON.parse(JSON.stringify(input?.messages ?? [])),
      tools: input?.tools ?? [],
      enableThinking: input?.enableThinking,
      thinkingBudget: input?.thinkingBudget
    })
    const entry = script.shift()
    const next = entry?.onCall
      ? await entry.onCall({ signal: input?.signal, onDelta: input?.onDelta })
      : entry ?? { content: '收到啦' }
    if (!entry?.onCall && input?.onDelta && next.content) {
      const mid = Math.ceil(next.content.length / 2)
      for (const part of [next.content.slice(0, mid), next.content.slice(mid)]) {
        if (part) input.onDelta(part)
      }
    }
    return {
      message: { role: 'assistant', content: next.content ?? '', tool_calls: next.tool_calls },
      finishReason: 'stop',
      usage: {},
      ...(next.reasoningContent ? { reasoningContent: next.reasoningContent } : {})
    }
  })
}))
vi.mock('../../src/main/services/rating/ratingService', () => ({
  FEATURE_REVISION: 'harness-test',
  getVisualTagsForSearch: vi.fn(async () => null),
  rateFileNow: vi.fn(async () => null)
}))

const { abortAnswer, ask, answer, isAnswering, listMessages, recallMessage } = await import(
  '../../src/main/services/ai/assistantService'
)

describe('ToolRegistry 单源校验与 Microcompaction', () => {
  it('按同一份 Schema 校验合法参数、坏 JSON、缺必填项、类型不符和未知工具', async () => {
    const sample = defineTool({
      name: 'sample_tool',
      description: '测试工具',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1 },
          tags: { type: 'array', maxItems: 2, items: { type: 'string' } }
        }
      },
      execute: (args) => ({ content: JSON.stringify({ ok: true, args }) })
    })
    const map = new Map([[sample.name, sample]])
    const env = {
      userText: '',
      query: '',
      hasInputContext: false,
      tags: [],
      dirs: undefined,
      includeR18: false,
      userMessageId: 1,
      readReferences: async () => []
    }
    const state = createInitialHarnessState(false, false)

    expect(validateToolArgs(sample.parameters, '{bad').ok).toBe(false)
    expect(validateToolArgs(sample.parameters, '[]').ok).toBe(false)
    expect(validateToolArgs(sample.parameters, '{}')).toEqual({ ok: false, error: '缺少必填参数 query' })
    expect(validateToolArgs(sample.parameters, '{"query":"a","limit":0}')).toEqual({ ok: false, error: '参数 limit 不能小于 1' })
    expect(validateToolArgs(sample.parameters, '{"query":"a","tags":["1","2","3"]}')).toEqual({
      ok: false,
      error: '参数 tags 最多 2 项'
    })

    const unknown = await dispatchTool(map, 'nope', '{}', env, state)
    expect(JSON.parse(unknown.content)).toEqual({ error: '没有 nope 这个工具' })

    const ok = await dispatchTool(map, 'sample_tool', '{"query":"蓝发","limit":5}', env, state)
    expect(JSON.parse(ok.content)).toEqual({ ok: true, args: { query: '蓝发', limit: 5 } })
  })

  it('microcompactTail 折叠更早步骤中冗长的 tool 输出，保留最近一步完整结果', () => {
    const longBody = JSON.stringify({ images: Array.from({ length: 40 }, (_, i) => ({ id: i, name: '图' + i })) })
    const tail = [
      { role: 'user' as const, content: '问题' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 't1' }] },
      { role: 'tool' as const, tool_call_id: 't1', content: longBody },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 't2' }] },
      { role: 'tool' as const, tool_call_id: 't2', content: longBody }
    ]
    const compacted = microcompactTail(tail, 200)
    expect(compacted[2].content).toContain('"compacted":true')
    expect(compacted[2].content).toContain(`"originalBytes":${Buffer.byteLength(longBody)}`)
    expect(compacted[4].content).toBe(longBody)
    // 原数组不被修改
    expect(tail[2].content).toBe(longBody)
  })

  it('normalizeVisualTags 与 evaluateVisualTags 通用支持任意 Danbooru 标签包含与排除', () => {
    expect(normalizeVisualTags([' Glasses ', 'school uniform', 'BAD TAG!', 'glasses'])).toEqual(['glasses', 'school_uniform'])
    expect(evaluateVisualTags(['1girl', 'glasses', 'school_uniform'], { include: ['glasses', 'school_uniform'], exclude: ['fox_ears'] })).toBe(true)
    expect(evaluateVisualTags(['1girl', 'glasses', 'fox_ears'], { include: ['glasses'], exclude: ['fox_ears'] })).toBe(false)
    expect(evaluateVisualTags(['1girl', 'glasses', '1boy'], { include: ['glasses'], ambiguous: ['1boy'] })).toBeNull()
  })
})

describe('AgentHarness 集成动态工具与通用视觉过滤', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-harness-'))
    const lib = join(dir, 'pics')
    mkdirSync(lib, { recursive: true })
    process.env.DASHSCOPE_API_KEY = 'test-key-harness'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query("INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', '类目录', $1)", [lib])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, display_name, visual_features) VALUES
        ('g1', 'PNG', 10, 100, 100, '眼镜学妹', '{"revision":"harness-test","tags":["1girl","glasses","school_uniform"]}'),
        ('g2', 'PNG', 10, 100, 100, '眼镜狐娘', '{"revision":"harness-test","tags":["1girl","glasses","fox_ears"]}'),
        ('g3', 'PNG', 10, 100, 100, '运动少女', '{"revision":"harness-test","tags":["1girl","track_jacket"]}');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, 1, '二次元/' || content_hash || '.png', now() FROM image;
      INSERT INTO tag (name, category_id) VALUES ('插画', 4);
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT id, 1, 'MANUAL', 'ACCEPTED' FROM image;
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

  it('通过 visualInclude 与 visualExclude 动态过滤任意视觉特征（眼镜且不含狐耳）', async () => {
    script.push({
      tool_calls: [
        {
          id: 's1',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({ visualInclude: ['glasses'], visualExclude: ['fox_ears'], contrast: [] })
          }
        }
      ]
    })
    const q = await ask({ conversationId: null, text: '找戴眼镜但不要狐耳的图', scope: null, includeR18: false })
    const r = await answer(q.conversation.id)
    expect(r.images.map((i) => i.name)).toEqual(['眼镜学妹'])
    expect(r.how).toContain('画面特征「glasses」')
    expect(r.how).toContain('排除特征「fox_ears」')
  })

  it('支持通过工具动态解释命中依据，以及单次与永久排除结果图', async () => {
    script.push({
      tool_calls: [
        {
          id: 's2',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({ visualInclude: ['glasses'], contrast: [] })
          }
        }
      ]
    })
    const q = await ask({ conversationId: null, text: '找戴眼镜的图', scope: null, includeR18: false })
    const initial = await answer(q.conversation.id)
    expect(initial.images.map((i) => i.name).sort()).toEqual(['眼镜学妹', '眼镜狐娘'])

    // 通过声明式 explain_match 工具解释命中依据
    script.push(
      { tool_calls: [{ id: 'e1', type: 'function', function: { name: 'explain_match', arguments: '{"position":1}' } }] },
      { content: '这张是因为本地识别记录命中了画面特征。' }
    )
    await ask({ conversationId: q.conversation.id, text: '请问这第一张为啥会出现在列表里？', scope: null, includeR18: false })
    const explained = await answer(q.conversation.id)
    expect(explained.text).toContain('画面特征')

    // 通过声明式 exclude_image 工具永久排除第二张
    const secondId = initial.images[1].imageId
    script.push({
      tool_calls: [{ id: 'x1', type: 'function', function: { name: 'exclude_image', arguments: '{"position":2,"permanent":true}' } }]
    })
    await ask({ conversationId: q.conversation.id, text: '第二个结果不好看，后面都别再带它', scope: null, includeR18: false })
    const excluded = await answer(q.conversation.id)
    expect(excluded.images.map((i) => i.imageId)).toEqual([initial.images[0].imageId])
    expect(excluded.text).toContain('记住了')

    // 下一轮新检索自动排除该图
    script.push({
      tool_calls: [
        {
          id: 's3',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({ visualInclude: ['glasses'], contrast: [] })
          }
        }
      ]
    })
    const fresh = await ask({ conversationId: null, text: '再找一次戴眼镜的', scope: null, includeR18: false })
    const afterExclude = await answer(fresh.conversation.id)
    expect(afterExclude.images.map((i) => i.imageId)).toEqual([initial.images[0].imageId])
    await getDatabase().pg.query('DELETE FROM ai_image_exclusion WHERE image_id = $1', [secondId])
  })

  it('工具循环期间按顺序推送交错叙事与动作块事件（不触发 reset），并持久化时间线 blocks', async () => {
    const events: Array<{ kind: string; text?: string; tool?: string; actionId?: string; summary?: string; status?: string }> = []
    script.push(
      {
        content: '先查一下',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_tags', arguments: '{}' } }]
      },
      { content: '标签都在这里了。' }
    )
    const q = await ask({ conversationId: null, text: '图库里有哪些标签？', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id, undefined, (ev) => events.push(ev))
    expect(reply.text).toBe('标签都在这里了。')
    expect(events.some((e) => e.kind === 'reset')).toBe(false)
    expect(events).toEqual([
      { kind: 'delta', text: '先查' },
      { kind: 'delta', text: '一下' },
      { kind: 'narration_commit', text: '先查一下' },
      {
        kind: 'action_start',
        actionId: 's0-0-t1',
        tool: 'list_tags',
        summary: '查看标签词表',
        status: 'running',
        block: { type: 'action', id: 's0-0-t1', tool: 'list_tags', summary: '查看标签词表', status: 'running' }
      },
      {
        kind: 'action_end',
        actionId: 's0-0-t1',
        tool: 'list_tags',
        summary: '查看标签词表 · 1 个',
        status: 'done',
        block: { type: 'action', id: 's0-0-t1', tool: 'list_tags', summary: '查看标签词表 · 1 个', status: 'done' }
      },
      { kind: 'delta', text: '标签都在' },
      { kind: 'delta', text: '这里了。' }
    ])
    expect(reply.blocks).toEqual([
      { type: 'narration', text: '先查一下' },
      { type: 'action', id: 's0-0-t1', tool: 'list_tags', summary: '查看标签词表 · 1 个', status: 'done' }
    ])
    const saved = (await listMessages(q.conversation.id)).at(-1)
    expect(saved?.blocks).toEqual(reply.blocks)
  })

  it('无画面向量时，keywordGroups + visualInclude + semantic 仍通过本地视觉特征命中', async () => {
    script.push({
      tool_calls: [
        {
          id: 'k1',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({
              keywordGroups: [['猫耳']],
              visualInclude: ['fox_ears'],
              semantic: '狐耳角色',
              contrast: ['兔耳角色']
            })
          }
        }
      ]
    })
    const q = await ask({ conversationId: null, text: '找没有猫耳字面名但有狐耳的图', scope: null, includeR18: false })
    const res = await answer(q.conversation.id)
    expect(res.images.map((i) => i.name)).toEqual(['眼镜狐娘'])
  })

  it('excludeShown: true 自动排除本段对话已展示过的图片', async () => {
    script.push({
      tool_calls: [
        {
          id: 'd1',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({ visualInclude: ['glasses'], visualExclude: ['fox_ears'], contrast: [] })
          }
        }
      ]
    })
    const q = await ask({ conversationId: null, text: '找戴眼镜但不要狐耳的图', scope: null, includeR18: false })
    const first = await answer(q.conversation.id)
    expect(first.images.map((i) => i.name)).toEqual(['眼镜学妹'])

    script.push(
      {
        tool_calls: [
          {
            id: 'd2',
            type: 'function',
            function: {
              name: 'search_images',
              arguments: JSON.stringify({ visualInclude: ['glasses'], excludeShown: true, contrast: [] })
            }
          }
        ]
      },
      { content: '换一张眼镜狐娘给你看看喵～' }
    )
    await ask({ conversationId: q.conversation.id, text: '还有其他的吗', scope: null, includeR18: false })
    const second = await answer(q.conversation.id)
    expect(second.images.map((i) => i.name)).toEqual(['眼镜狐娘'])
    expect(second.text).toBe('换一张眼镜狐娘给你看看喵～')
  })

  it('对话式追问注入 [会话状态]（绝不泄露 R-18 图名），且 allAlreadyShown 时流式输出第二步暖心回复', async () => {
    const { pg } = getDatabase()
    const { rows: [r18] } = await pg.query<{ id: number }>(`
      INSERT INTO image (content_hash, format, byte_size, width, height, display_name, is_r18, visual_features)
      VALUES ('g-r18', 'PNG', 10, 100, 100, '绝对机密R18图', true, '{"revision":"harness-test","tags":["1girl","glasses"]}')
      RETURNING id
    `)
    await pg.query("INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES ($1, 1, '二次元/g-r18.png', now())", [r18.id])
    await pg.query("INSERT INTO image_tag (image_id, tag_id, source, status) VALUES ($1, 1, 'MANUAL', 'ACCEPTED')", [r18.id])
    try {
      script.push(
        {
          tool_calls: [
            {
              id: 'a1',
              type: 'function',
              function: {
                name: 'search_images',
                arguments: JSON.stringify({ tags: ['插画'], visualInclude: ['glasses'], contrast: [] })
              }
            }
          ]
        },
        { content: '找到三张戴眼镜的插画啦～' }
      )
      const q = await ask({ conversationId: null, text: '找插画里戴眼镜的图', scope: null, includeR18: true })
      const first = await answer(q.conversation.id)
      expect(first.images.map((i) => i.name).sort()).toEqual(['眼镜学妹', '眼镜狐娘', '绝对机密R18图'])

      const events: Array<{ kind: string; text?: string; tool?: string }> = []
      script.push(
        {
          tool_calls: [
            {
              id: 'a2',
              type: 'function',
              function: {
                name: 'search_images',
                arguments: JSON.stringify({ tags: ['插画'], visualInclude: ['glasses'], excludeShown: true, contrast: [] })
              }
            }
          ]
        },
        { content: '我也超喜欢这张的喵！图库里戴眼镜的暂时都给你看过啦～' }
      )
      await ask({ conversationId: q.conversation.id, text: '诺诺，这张我超喜欢！还有其他的吗', scope: null, includeR18: true })
      const reply = await answer(q.conversation.id, undefined, (ev) => events.push(ev))

      expect(reply.images).toEqual([])
      expect(reply.text).toBe('我也超喜欢这张的喵！图库里戴眼镜的暂时都给你看过啦～')
      expect(reply.text).not.toBe('没找到符合条件的图片。')
      expect(events.some((e) => e.kind === 'delta')).toBe(true)

      const step0OfTurn2 = String((calls[2].messages.at(-2) as { content?: unknown })?.content ?? '')
      expect(step0OfTurn2).toContain('[会话状态]')
      expect(step0OfTurn2).toContain('本段对话已展示过 3 张图')
      expect(step0OfTurn2).toContain('眼镜学妹')
      expect(step0OfTurn2).not.toContain('绝对机密R18图')
      expect(JSON.stringify(calls[2].messages[0])).toBe(JSON.stringify(calls[0].messages[0]))

      const toolMsg = (calls[3].messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')
      expect(JSON.parse(toolMsg!.content)).toMatchObject({ total: 0, alreadyShownCount: 3, allAlreadyShown: true })
    } finally {
      await pg.query('UPDATE image SET delete_state = 1 WHERE id = $1', [r18.id])
    }
  })

  it('同轮重复调用完全相同参数的工具会被拦截并返回提示', async () => {
    script.push(
      {
        tool_calls: [
          { id: 'dup1', type: 'function', function: { name: 'get_image', arguments: '{"id":1}' } },
          { id: 'dup2', type: 'function', function: { name: 'get_image', arguments: '{ "id" : 1 }' } }
        ]
      },
      { content: '这张图已经看过了。' }
    )
    const q = await ask({ conversationId: null, text: '看看图1', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(reply.text).toBe('这张图已经看过了。')
    const toolMsgs = (calls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs[1].content).toContain('本轮已经用完全相同的参数调用过该工具')
  })

  it('reduceToolOutcome 对 memoryNotices 去重并限制最多 2 条', () => {
    let s = createInitialHarnessState(false, false)
    s = reduceToolOutcome(s, 'remember', { type: 'memory', action: 'save', notice: '诺诺记住第一条啦' })
    s = reduceToolOutcome(s, 'remember', { type: 'memory', action: 'save', notice: '诺诺记住第一条啦' })
    s = reduceToolOutcome(s, 'remember', { type: 'memory', action: 'update', notice: '诺诺改好第二条啦' })
    s = reduceToolOutcome(s, 'remember', { type: 'memory', action: 'forget', notice: '第三条应被截断' })
    expect(s.memoryNotices).toEqual(['诺诺记住第一条啦', '诺诺改好第二条啦'])
  })

  it('remember 支持跨轮更新/遗忘、无 evidence 限制、notice 兜底及 recall_memories 与撤回恢复', async () => {
    const { pg } = getDatabase()
    try {
      // 1. 保存偏好（省略 notice 时用自然人味兜底）
      script.push(
        {
          tool_calls: [
            {
              id: 'm1',
              type: 'function',
              function: { name: 'remember', arguments: JSON.stringify({ content: '喜欢吃冬瓜' }) }
            }
          ]
        },
        { content: '好的，诺诺记住啦！' }
      )
      const q1 = await ask({ conversationId: null, text: '其实我对吃的有点讲究', scope: null, includeR18: false })
      const r1 = await answer(q1.conversation.id)
      expect(r1.memoryNotice).toEqual({ action: 'save', notices: ['诺诺记住啦：喜欢吃冬瓜'] })

      // 2. 跨轮纠正：省略 replaceId 与 evidence，自动匹配并替换旧记忆
      script.push(
        {
          tool_calls: [
            {
              id: 'm2',
              type: 'function',
              function: {
                name: 'remember',
                arguments: JSON.stringify({
                  action: 'update',
                  content: '喜欢吃南瓜',
                  notice: '诺诺知道主人喜欢吃南瓜而不是冬瓜 ฅ^•ﻌ•^ฅ'
                })
              }
            }
          ]
        },
        { content: '收到，已经换成南瓜啦～' }
      )
      const q2 = await ask({ conversationId: q1.conversation.id, text: '我更喜欢 B 啦，不吃那个了', scope: null, includeR18: false })
      const r2 = await answer(q2.conversation.id)
      expect(r2.memoryNotice).toEqual({ action: 'update', notices: ['诺诺知道主人喜欢吃南瓜而不是冬瓜 ฅ^•ﻌ•^ฅ'] })
      const historyMsgs = await listMessages(q1.conversation.id)
      expect(historyMsgs.at(-1)?.memoryNotice).toEqual(r2.memoryNotice)

      // 3. recall_memories 只读查询当前有效记忆
      script.push(
        {
          tool_calls: [{ id: 'rc1', type: 'function', function: { name: 'recall_memories', arguments: '{}' } }]
        },
        { content: '诺诺记得你喜欢吃南瓜喵。' }
      )
      await ask({ conversationId: q1.conversation.id, text: '你记得我什么呀', scope: null, includeR18: false })
      const r3 = await answer(q1.conversation.id)
      expect(r3.text).toContain('南瓜')
      const recallToolMsg = (calls.at(-1)?.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')
      const recalled = JSON.parse(recallToolMsg!.content) as { memories: Array<{ id: number; content: string }> }
      expect(recalled.memories.map((m) => m.content)).toEqual(['喜欢吃南瓜'])

      // 4. forget 遗忘，且撤回用户消息后被遗忘的记忆可恢复
      const targetId = recalled.memories[0].id
      script.push(
        {
          tool_calls: [
            {
              id: 'mf1',
              type: 'function',
              function: {
                name: 'remember',
                arguments: JSON.stringify({
                  action: 'forget',
                  replaceId: targetId,
                  notice: '诺诺把吃南瓜的偏好忘掉啦'
                })
              }
            }
          ]
        },
        { content: '好哒，这件事诺诺已经忘掉啦。' }
      )
      const q4 = await ask({ conversationId: q1.conversation.id, text: '别记这个了', scope: null, includeR18: false })
      const r4 = await answer(q4.conversation.id)
      expect(r4.memoryNotice).toEqual({ action: 'forget', notices: ['诺诺把吃南瓜的偏好忘掉啦'] })
      const afterForget = await pg.query<{ id: number }>('SELECT id FROM ai_memory WHERE delete_state = 0 AND valid_to IS NULL')
      expect(afterForget.rows).toHaveLength(0)

      await recallMessage(q1.conversation.id, q4.message.id)
      const afterRecall = await pg.query<{ content: string }>('SELECT content FROM ai_memory WHERE delete_state = 0 AND valid_to IS NULL')
      expect(afterRecall.rows.map((r) => r.content)).toEqual(['喜欢吃南瓜'])
    } finally {
      await pg.query('DELETE FROM ai_memory')
    }
  })

  it('0 命中返回 closestTags 后自动开启自适应思考（512 budget）、保留 reasoning_content 并自愈重试；并发只读工具同步执行', async () => {
    const events: Array<{ kind: string; memoryNotice?: unknown }> = []
    script.push(
      {
        content: '先搜一下看看',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'search_images', arguments: JSON.stringify({ tags: ['插画画'], contrast: [] }) }
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'list_tags', arguments: '{}' }
          }
        ]
      },
      {
        content: '没直接找到，换相近的「插画」试试…',
        reasoningContent: '刚才搜插画画返回了 closestTags: 插画，换用精确标签重试。',
        tool_calls: [
          {
            id: 'c3',
            type: 'function',
            function: { name: 'search_images', arguments: JSON.stringify({ tags: ['插画'], visualInclude: ['glasses'], contrast: [] }) }
          }
        ]
      },
      {
        content: '找到了这两张戴眼镜的插画！'
      }
    )
    const q = await ask({ conversationId: null, text: '找插画画里戴眼镜的图', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id, undefined, (ev) => events.push(ev))

    expect(reply.text).toBe('找到了这两张戴眼镜的插画！')
    expect(reply.images.map((i) => i.name).sort()).toEqual(['眼镜学妹', '眼镜狐娘'])
    expect(calls).toHaveLength(3)
    expect(calls[0].enableThinking).toBe(false)
    expect(calls[1].enableThinking).toBe(true)
    expect(calls[1].thinkingBudget).toBe(512)
    expect(calls[2].enableThinking).toBe(false)

    // 第 1 步返回的 closestTags 供模型决策，第 2 步产出的 reasoning_content 保留在历史 assistant 消息中
    const step1Tool = (calls[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')
    expect(JSON.parse(step1Tool!.content)).toMatchObject({ total: 0, closestTags: ['插画'] })
    const step2Assistant = (calls[2].messages as Array<{ role: string; reasoning_content?: string }>).findLast(
      (m) => m.role === 'assistant' && m.reasoning_content
    )
    expect(step2Assistant?.reasoning_content).toContain('closestTags')

    expect(reply.blocks).toEqual([
      { type: 'narration', text: '先搜一下看看' },
      { type: 'action', id: 's0-0-c1', tool: 'search_images', summary: '检索图库：插画画 · 0 张', status: 'done' },
      { type: 'action', id: 's0-1-c2', tool: 'list_tags', summary: '查看标签词表 · 1 个', status: 'done' },
      { type: 'narration', text: '没直接找到，换相近的「插画」试试…' },
      { type: 'action', id: 's1-0-c3', tool: 'search_images', summary: '检索图库：插画、glasses · 2 张', status: 'done' }
    ])
  })

  it('保留诺诺自然口吻历史并注入第④层动态 [情景] 提示（防重复喵与中断衔接），同时保持前缀完全一致', async () => {
    const { pg } = getDatabase()
    script.push(
      { tool_calls: [{ id: 'v1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['插画'], contrast: [] }) } }] },
      { content: '这几张插画好温柔喵~' }
    )
    const q1 = await ask({ conversationId: null, text: '找插画图', scope: null, includeR18: false })
    await answer(q1.conversation.id)

    script.push({ content: '我也很喜欢这个色调 ฅ^•ﻌ•^ฅ' })
    await ask({ conversationId: q1.conversation.id, text: '好好看呀', scope: null, includeR18: false })
    await answer(q1.conversation.id)

    // 人为写入一条 interrupted 助手记录模拟上轮被打断
    await pg.query(
      "INSERT INTO ai_message (conversation_id, role, content) VALUES ($1, 'USER', $2)",
      [q1.conversation.id, JSON.stringify({ text: '再找找别的', scope: null, includeR18: false })]
    )
    await pg.query(
      "INSERT INTO ai_message (conversation_id, role, content) VALUES ($1, 'ASSISTANT', $2)",
      [
        q1.conversation.id,
        JSON.stringify({
          text: '刚准备看看喵…',
          how: null,
          imageIds: [],
          interrupted: true,
          blocks: [{ type: 'action', id: 'a1', tool: 'search_images', summary: '检索图库：猫 · 0 张', status: 'aborted' }]
        })
      ]
    )

    script.push({ content: '明白，直接按新条件接着看！' })
    await ask({ conversationId: q1.conversation.id, text: '换看运动少女', scope: null, includeR18: false })
    await answer(q1.conversation.id)

    const latestMsgs = calls.at(-1)!.messages as Array<{ role: string; content: unknown }>
    // 历史保留第 1 轮自然口吻（不替换成“本轮查询了图库”）以及中断记录
    const historyStr = JSON.stringify(latestMsgs.slice(1, -2))
    expect(historyStr).toContain('这几张插画好温柔喵~')
    expect(historyStr).not.toContain('（本轮查询了图库。）')
    expect(historyStr).toContain('[软件记录] 上轮对话被主人半途打断；已执行：检索图库：猫 · 0 张')

    // 第④层注入两条动态 [情景] 提示，且第①②层系统前缀保持字节一致
    const tailSystem = String((latestMsgs.at(-2) as { content?: unknown })?.content ?? '')
    expect(tailSystem).toContain('[情景] 最近两轮刚用过“喵”或类似颜文字')
    expect(tailSystem).toContain('[情景] 上一轮在半途被主人打断')
    expect(JSON.stringify(latestMsgs[0])).toBe(JSON.stringify(calls[0].messages[0]))
  })

  it('支持在工具循环中实时打断：保存部分 blocks/memoryNotice/结果图与 interrupted，释放锁并在下一轮注入动作摘要', async () => {
    const { pg } = getDatabase()
    try {
      let releaseStep1!: () => void
      const enteredStep1 = new Promise<void>((resolve) => {
        releaseStep1 = resolve
      })
      script.push(
        {
          content: '先找一下戴眼镜的图并记下你的偏好…',
          tool_calls: [
            {
              id: 's1',
              type: 'function',
              function: { name: 'search_images', arguments: JSON.stringify({ visualInclude: ['glasses'], contrast: [] }) }
            },
            {
              id: 'm1',
              type: 'function',
              function: {
                name: 'remember',
                arguments: JSON.stringify({ content: '喜欢眼镜少女', notice: '诺诺记住你喜欢眼镜少女啦' })
              }
            }
          ]
        },
        {
          onCall: async ({ signal, onDelta }) => {
            onDelta?.('我先帮你找到了这几张，')
            releaseStep1()
            return await new Promise((_, reject) => {
              const onAbort = () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }))
              if (signal?.aborted) onAbort()
              else signal?.addEventListener('abort', onAbort, { once: true })
            })
          }
        }
      )

      expect(await abortAnswer(999999)).toBe(false)
      const q = await ask({ conversationId: null, text: '找眼镜图，以后记住我喜欢眼镜少女', scope: null, includeR18: false })
      const events: Array<{ kind: string; text?: string }> = []
      const pendingReply = answer(q.conversation.id, undefined, (ev) => events.push(ev))
      await enteredStep1
      expect(isAnswering()).toBe(true)

      const aborted = await abortAnswer(q.conversation.id)
      expect(aborted).toBe(true)
      expect(isAnswering()).toBe(false)
      expect(await abortAnswer(q.conversation.id)).toBe(false)

      const partialReply = await pendingReply
      expect(partialReply.interrupted).toBe(true)
      expect(partialReply.text).toBe('我先帮你找到了这几张，')
      expect(partialReply.images.map((i) => i.name).sort()).toEqual(['眼镜学妹', '眼镜狐娘'])
      expect(partialReply.memoryNotice).toEqual({ action: 'save', notices: ['诺诺记住你喜欢眼镜少女啦'] })
      expect(partialReply.blocks).toEqual([
        { type: 'narration', text: '先找一下戴眼镜的图并记下你的偏好…' },
        { type: 'action', id: 's0-0-s1', tool: 'search_images', summary: '检索图库：glasses · 2 张', status: 'done' },
        { type: 'action', id: 's0-1-m1', tool: 'remember', summary: '记住一条偏好 · 已保存', status: 'done' }
      ])
      expect(events.some((e) => e.kind === 'error')).toBe(false)

      const saved = (await listMessages(q.conversation.id)).at(-1)!
      expect(saved).toMatchObject({
        interrupted: true,
        text: '我先帮你找到了这几张，',
        memoryNotice: partialReply.memoryNotice,
        blocks: partialReply.blocks
      })

      // 下一轮紧接着插嘴提问不报 CONFLICT，且模型上下文能看到上轮被中断时已执行的动作摘要与 [情景] 提示
      script.push({ content: '好嘞，那我接着按刚才的结果给你挑一张~' })
      await ask({ conversationId: q.conversation.id, text: '不用全看了，只挑第一张就行', scope: null, includeR18: false })
      const followReply = await answer(q.conversation.id)
      expect(followReply.text).toBe('好嘞，那我接着按刚才的结果给你挑一张~')

      const followMsgs = calls.at(-1)!.messages as Array<{ role: string; content: unknown }>
      const prevAssistantStr = JSON.stringify(followMsgs.find((m) => m.role === 'assistant'))
      expect(prevAssistantStr).toContain('[软件记录] 上轮对话被主人半途打断；已执行：检索图库：glasses · 2 张；记住一条偏好 · 已保存')
      expect(String((followMsgs.at(-2) as { content?: unknown })?.content ?? '')).toContain('[情景] 上一轮在半途被主人打断')
    } finally {
      await pg.query('DELETE FROM ai_memory')
    }
  })

  it('reply_with_followup 静默提交回答且不产生重复叙事段落或过程步骤行', async () => {
    const story = '从前有一只住在钟楼顶层的小白猫，每天帮月亮擦拭微光。'
    script.push({
      content: story,
      tool_calls: [
        {
          id: 'rf1',
          type: 'function',
          function: {
            name: 'reply_with_followup',
            arguments: JSON.stringify({ answer: story, suggestion: '换一个温暖一点的结局' })
          }
        }
      ]
    })

    const q = await ask({ conversationId: null, text: '讲个睡前小故事', scope: null, includeR18: false })
    const events: Array<{ kind: string; tool?: string; text?: string }> = []
    const reply = await answer(q.conversation.id, undefined, (ev) => events.push(ev))

    expect(reply.text).toBe(story)
    expect(reply.blocks ?? []).toEqual([])
    expect(events.some((e) => e.kind === 'narration_commit')).toBe(false)
    expect(events.some((e) => e.kind === 'action_start' || e.kind === 'action_end')).toBe(false)
  })

  it('词表在类目录内变更后立即热感知（新对话更新档案版、进行中对话仅第④层注入增量并严格排除 AI 建议与源目录图）', async () => {
    const { pg } = getDatabase()
    // 先起一段对话锁定旧档案版本（不包含“新热标签”）
    script.push({ content: '好呀，我现在记得当前词表。' })
    const qOld = await ask({ conversationId: null, text: '先打个招呼', scope: null, includeR18: false })
    await answer(qOld.conversation.id)
    const oldPrefix = JSON.stringify(calls.at(-1)!.messages[0])

    // 新增三个标签：仅「热感知星空」用于类目录且已确认；「仅建议雪花」仍处 PENDING；「仅源目录火羽」不在类目录
    await pg.exec(`
      INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'src', 'D:/tmp-src');
      INSERT INTO image (content_hash, format, byte_size, display_name, thumb_ready) VALUES
        ('hot-cat', 'PNG', 10, '热感知图', 1),
        ('hot-pend', 'PNG', 10, '待确认图', 1),
        ('hot-src', 'PNG', 10, '源目录图', 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, CASE content_hash WHEN 'hot-src' THEN (SELECT max(id) FROM library_root WHERE kind='SOURCE') ELSE 1 END,
               CASE content_hash WHEN 'hot-src' THEN 'hot-src.png' ELSE '二次元/' || content_hash || '.png' END, now()
        FROM image WHERE content_hash IN ('hot-cat', 'hot-pend', 'hot-src');
      INSERT INTO tag (name, category_id) VALUES ('热感知星空', 4), ('仅建议雪花', 4), ('仅源目录火羽', 4);
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT i.id, t.id, 'MANUAL', 'ACCEPTED' FROM image i JOIN tag t ON
          (i.content_hash = 'hot-cat' AND t.name = '热感知星空')
          OR (i.content_hash = 'hot-pend' AND t.name = '仅建议雪花')
          OR (i.content_hash = 'hot-src' AND t.name = '仅源目录火羽');
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
        SELECT id, 'IDENTIFY', 'm', '{"name":"待审"}', '{"name":"PENDING"}' FROM image WHERE content_hash = 'hot-pend';
    `)

    // 1. 进行中老对话继续发消息：第①②层前缀保持字节一致，同时第④层立即注入「热感知星空」，不含 PENDING 和源目录词
    script.push({ content: '我看到新增了热感知星空标签啦~' })
    await ask({ conversationId: qOld.conversation.id, text: '刚整理了新图吗', scope: null, includeR18: false })
    await answer(qOld.conversation.id)
    const ongoingMsgs = calls.at(-1)!.messages as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(ongoingMsgs[0])).toBe(oldPrefix)
    const ongoingTail = String((ongoingMsgs.at(-2) as { content?: unknown })?.content ?? '')
    expect(ongoingTail).toContain('热感知星空')
    expect(ongoingTail).not.toContain('仅建议雪花')
    expect(ongoingTail).not.toContain('仅源目录火羽')

    // 2. 不等待 24 小时新开对话：档案版本号立即递增且第①②层词表已含「热感知星空」（不含待审与源目录）
    script.push({ content: '新对话也已经知道热感知星空啦~' })
    const qNew = await ask({ conversationId: null, text: '看看现在有什么新标签', scope: null, includeR18: false })
    expect(qNew.conversation.id).not.toBe(qOld.conversation.id)
    await answer(qNew.conversation.id)
    const newPrefix = JSON.stringify(calls.at(-1)!.messages[0])
    expect(newPrefix).toContain('热感知星空')
    expect(newPrefix).not.toContain('仅建议雪花')
    expect(newPrefix).not.toContain('仅源目录火羽')
  })
})
