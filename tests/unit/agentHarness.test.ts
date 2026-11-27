import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { bumpLibraryVersion, getCachedDictionary, setCachedDictionary } from '../../src/main/common/readCache'
import { PERSONA_FEW_SHOT_MESSAGES } from '../../src/main/services/ai/assistantPrompt'
import { microcompactTail } from '../../src/main/services/ai/harness/context'
import { buildPersonaCue, detectPersonaStance, isPureBanter } from '../../src/main/services/ai/harness/personaState'
import { ACTION_ICON, actionIconPath, splitActionSummary, visibleTimelineBlocks } from '../../src/renderer/src/utils/actionDisplay'
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
  }),
  searchCall: vi.fn(async (input?: { text?: string }) => ({
    text: `已过滤：${input?.text ?? ''} 的核心权威信息摘要`,
    sources: [{ url: 'https://example.com/wiki/arona', title: 'ArWiki' }],
    usage: { inputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, outputTokens: 20, searchCount: 1 }
  }))
}))
vi.mock('../../src/main/services/rating/ratingService', () => ({
  FEATURE_REVISION: 'harness-test',
  getVisualTagsForSearch: vi.fn(async () => null),
  rateFileNow: vi.fn(async () => null)
}))

const { abortAnswer, ask, answer, compactConversation, isAnswering, listMessages, recallMessage } = await import(
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
      includeOrganized: false,
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

    // 第④层注入动态避重与中断衔接提示，且第①②层系统前缀保持字节一致
    const tailSystem = String((latestMsgs.at(-2) as { content?: unknown })?.content ?? '')
    expect(tailSystem).toContain('[表达避重] 最近两轮刚用过“喵”或颜文字')
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
      const prevAssistantStr = JSON.stringify(followMsgs.findLast((m) => m.role === 'assistant'))
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

  it('可检索范围为空时 search_images 返回 scopeEmpty，且助手保留诺诺口吻回复不被静态文案覆盖', async () => {
    const { pg } = getDatabase()
    // 清空测试图像，仅留空白类目录
    await pg.exec('UPDATE image SET delete_state = 1 WHERE delete_state = 0')

    // 1. 直接触发空范围快路径时使用温暖的诺诺口吻
    const qFast = await ask({ conversationId: null, text: '帮我找几张可爱的猫娘图片', scope: null, includeR18: false })
    const rFast = await answer(qFast.conversation.id)
    expect(rFast.text).toContain('诺诺把类目录翻了一遍')

    // 2. 经由大模型工具循环拿到 scopeEmpty 后，模型生成的真实回复不被覆盖
    script.push(
      {
        tool_calls: [
          { id: 'empty-1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['猫娘'], contrast: [] }) } }
        ]
      },
      { content: '诺诺翻了一遍相册，现在类目录里还没有猫娘图呀，先去归档几张吧 ฅ^•ﻌ•^ฅ' }
    )
    const q = await ask({ conversationId: null, text: '图库里有适合做头像的可爱猫耳角色吗，我想翻翻看', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)

    expect(reply.text).toBe('诺诺翻了一遍相册，现在类目录里还没有猫娘图呀，先去归档几张吧 ฅ^•ﻌ•^ฅ')
    expect(reply.how).toBeNull()
    const toolMsgs = calls.at(-1)!.messages as Array<{ role: string; content?: unknown }>
    const toolPayload = JSON.parse(String(toolMsgs.findLast((m) => m.role === 'tool')?.content ?? '{}'))
    expect(toolPayload.scopeEmpty).toBe(true)
    expect(typeof toolPayload.scopeReason).toBe('string')
  })

  it('search_images 首次调用前若模型抢先报喜不会被固化为 narration，工具返回后正式回复完整保留', async () => {
    const { pg } = getDatabase()
    // 恢复可检索的类目录图片，确保进入大模型工具循环而不是快路径空范围拦截
    await pg.exec('UPDATE image SET delete_state = 0 WHERE delete_state = 1')

    const streamed: Array<{ kind: string; text?: string }> = []
    script.push(
      {
        content: "找到啦，这几张都是软乎乎萌系的，给你看看 (ฅ'ω'ฅ)",
        tool_calls: [
          { id: 'premature-1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['不存在的萌系标签'], contrast: [] }) } }
        ]
      },
      { content: '翻了一遍类目录，还没有符合条件的萌系图呢 (´；ω；`)' }
    )
    const q = await ask({ conversationId: null, text: '去找找看有没有萌系图', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id, undefined, (ev) => streamed.push({ kind: ev.kind, text: ev.text }))

    expect(reply.blocks?.some((b) => b.type === 'narration')).toBe(false)
    expect(streamed.some((e) => e.kind === 'narration_commit')).toBe(false)
    expect(reply.text).toBe('翻了一遍类目录，还没有符合条件的萌系图呢 (´；ω；`)')
  })

  it('类目录为空但源目录已有已确认标签的图片时，提示留在源目录的张数且绝不越界检索源目录', async () => {
    const { pg } = getDatabase()
    await pg.exec('UPDATE image SET delete_state = 1 WHERE delete_state = 0')
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name, thumb_ready) VALUES
        ('outside-cat-1', 'PNG', 10, '源目录猫娘A', 1),
        ('outside-cat-2', 'PNG', 10, '源目录猫娘B', 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, (SELECT max(id) FROM library_root WHERE kind = 'SOURCE'), content_hash || '.png', now()
        FROM image WHERE content_hash IN ('outside-cat-1', 'outside-cat-2');
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT id, 1, 'MANUAL', 'ACCEPTED' FROM image WHERE content_hash IN ('outside-cat-1', 'outside-cat-2');
    `)

    const q = await ask({ conversationId: null, text: '帮我找几张可爱的猫娘图片', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id)

    expect(reply.images).toEqual([])
    expect(reply.how).toBeNull()
    expect(reply.text).toContain('诺诺把类目录翻了一遍')
    expect(reply.text).toContain('2 张已经确认好标签的图还留在源目录里')
    expect(calls).toHaveLength(0)
  })

  it('organized 范围可检索源目录已整理图片并按 image.id 严格去重，null 范围仍严格限定在类目录', async () => {
    const { pg } = getDatabase()
    await pg.exec('UPDATE image SET delete_state = 1 WHERE delete_state = 0')
    await pg.exec(`
      INSERT INTO library_root (kind, name, path)
        SELECT 'SOURCE', 'src', 'D:/tmp-src'
        WHERE NOT EXISTS (SELECT 1 FROM library_root WHERE kind = 'SOURCE' AND delete_state = 0);
      INSERT INTO image (content_hash, format, byte_size, display_name, thumb_ready) VALUES
        ('org-cat-only', 'PNG', 10, '双域类目录图', 1),
        ('org-src-only', 'PNG', 10, '双域源目录图', 1),
        ('org-both', 'PNG', 10, '双域双位置图', 1),
        ('org-src-pending', 'PNG', 10, '双域待审源图', 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, 1, '二次元/' || content_hash || '.png', now()
        FROM image WHERE content_hash IN ('org-cat-only', 'org-both');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, (SELECT max(id) FROM library_root WHERE kind = 'SOURCE' AND delete_state = 0), content_hash || '.png', now()
        FROM image WHERE content_hash IN ('org-src-only', 'org-both', 'org-src-pending');
      INSERT INTO tag (name, category_id) VALUES ('双范围测试', 4) ON CONFLICT DO NOTHING;
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT i.id, (SELECT id FROM tag WHERE name = '双范围测试' LIMIT 1), 'MANUAL', 'ACCEPTED'
        FROM image i WHERE i.content_hash IN ('org-cat-only', 'org-src-only', 'org-both', 'org-src-pending');
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
        SELECT id, 'IDENTIFY', 'm', '{"name":"待审"}', '{"name":"PENDING"}'
        FROM image WHERE content_hash = 'org-src-pending';
    `)

    script.push({
      tool_calls: [
        { id: 'org-1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['双范围测试'], contrast: [] }) } }
      ]
    })
    const qOrg = await ask({ conversationId: null, text: '找双范围测试的图', scope: { kind: 'organized' }, includeR18: false })
    const rOrg = await answer(qOrg.conversation.id)
    expect(rOrg.images.map((i) => i.name).sort()).toEqual(['双域双位置图', '双域源目录图', '双域类目录图'].sort())

    script.push({
      tool_calls: [
        { id: 'cat-1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['双范围测试'], contrast: [] }) } }
      ]
    })
    const qCat = await ask({ conversationId: null, text: '只看类目录里双范围测试的图', scope: null, includeR18: false })
    const rCat = await answer(qCat.conversation.id)
    expect(rCat.images.map((i) => i.name).sort()).toEqual(['双域双位置图', '双域类目录图'].sort())
  })

  it('organized 范围支持轮间与回答中途双层热注入，且第①②层前缀始终保持字节一致', async () => {
    const { pg } = getDatabase()
    await pg.exec('UPDATE image SET delete_state = 1 WHERE delete_state = 0')
    await pg.exec(`
      INSERT INTO library_root (kind, name, path)
        SELECT 'SOURCE', 'src', 'D:/tmp-src'
        WHERE NOT EXISTS (SELECT 1 FROM library_root WHERE kind = 'SOURCE' AND delete_state = 0);
      INSERT INTO image (content_hash, format, byte_size, display_name, thumb_ready) VALUES
        ('hot2-base', 'PNG', 10, '热注入基础图', 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, 1, '二次元/hot2-base.png', now() FROM image WHERE content_hash = 'hot2-base';
      INSERT INTO tag (name, category_id) VALUES ('热注入基础', 4) ON CONFLICT DO NOTHING;
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT i.id, (SELECT id FROM tag WHERE name = '热注入基础' LIMIT 1), 'MANUAL', 'ACCEPTED'
        FROM image i WHERE i.content_hash = 'hot2-base';
    `)

    script.push({ content: '好呀，我记住当前词表啦。' })
    const q = await ask({ conversationId: null, text: '先打个招呼', scope: { kind: 'organized' }, includeR18: false })
    await answer(q.conversation.id)
    const oldPrefix = JSON.stringify(calls.at(-1)!.messages[0])

    // 轮间新增：仅在源目录且已确认标签的新图片
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name, thumb_ready) VALUES
        ('hot2-turn', 'PNG', 10, '轮间源目录新图', 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, (SELECT max(id) FROM library_root WHERE kind = 'SOURCE' AND delete_state = 0), 'hot2-turn.png', now()
        FROM image WHERE content_hash = 'hot2-turn';
      INSERT INTO tag (name, category_id) VALUES ('轮间新源标签', 4) ON CONFLICT DO NOTHING;
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT i.id, (SELECT id FROM tag WHERE name = '轮间新源标签' LIMIT 1), 'MANUAL', 'ACCEPTED'
        FROM image i WHERE i.content_hash = 'hot2-turn';
    `)

    script.push(
      {
        onCall: async () => {
          // 模拟回答中途 step 0 执行期间后台刚完成一批整理并触发版本递增
          await pg.exec(`
            INSERT INTO image (content_hash, format, byte_size, display_name, thumb_ready) VALUES
              ('hot2-mid', 'PNG', 10, '中途新图', 1);
            INSERT INTO image_file (image_id, root_id, rel_path, mtime)
              SELECT id, (SELECT max(id) FROM library_root WHERE kind = 'SOURCE' AND delete_state = 0), 'hot2-mid.png', now()
              FROM image WHERE content_hash = 'hot2-mid';
            INSERT INTO tag (name, category_id) VALUES ('回答中途新标签', 4) ON CONFLICT DO NOTHING;
            INSERT INTO image_tag (image_id, tag_id, source, status)
              SELECT i.id, (SELECT id FROM tag WHERE name = '回答中途新标签' LIMIT 1), 'MANUAL', 'ACCEPTED'
              FROM image i WHERE i.content_hash = 'hot2-mid';
          `)
          bumpLibraryVersion()
          return {
            tool_calls: [{ id: 'mid-check', type: 'function', function: { name: 'list_tags', arguments: '{}' } }]
          }
        }
      },
      { content: '刚看到轮间和中途新增的标签都到齐了~' }
    )

    await ask({ conversationId: q.conversation.id, text: '帮我看看现在有哪些标签', scope: { kind: 'organized' }, includeR18: false })
    const reply = await answer(q.conversation.id)
    expect(reply.text).toContain('都到齐了')

    const step0Msgs = calls.at(-2)!.messages as Array<{ role: string; content?: unknown }>
    const step1Msgs = calls.at(-1)!.messages as Array<{ role: string; content?: unknown }>
    expect(JSON.stringify(step0Msgs[0])).toBe(oldPrefix)
    expect(JSON.stringify(step1Msgs[0])).toBe(oldPrefix)

    const step0Tail = String((step0Msgs.at(-2) as { content?: unknown })?.content ?? '')
    expect(step0Tail).toContain('全部类目录与已整理图片')
    expect(step0Tail).toContain('轮间新源标签')

    const midNotice = step1Msgs.find(
      (m) => m.role === 'system' && JSON.stringify(m.content).includes('[图库实时新增]')
    )
    expect(JSON.stringify(midNotice?.content ?? '')).toContain('回答中途新标签')
    expect(JSON.stringify(midNotice?.content ?? '')).not.toContain('轮间新源标签')
  })

  it('版本化检索词典缓存按 includeOrganized 独立命中并在 bumpLibraryVersion 后失效', () => {
    bumpLibraryVersion()
    expect(getCachedDictionary(false, { bypassVitest: true })).toBeUndefined()
    expect(getCachedDictionary(true, { bypassVitest: true })).toBeUndefined()

    const catDict = { tags: [{ id: 1 }], dirs: [] }
    const orgDict = { tags: [{ id: 1 }, { id: 2 }], dirs: [] }
    setCachedDictionary(false, catDict, { bypassVitest: true })
    setCachedDictionary(true, orgDict, { bypassVitest: true })

    expect(getCachedDictionary(false, { bypassVitest: true })).toBe(catDict)
    expect(getCachedDictionary(true, { bypassVitest: true })).toBe(orgDict)

    bumpLibraryVersion()
    expect(getCachedDictionary(false, { bypassVitest: true })).toBeUndefined()
    expect(getCachedDictionary(true, { bypassVitest: true })).toBeUndefined()
  })

  it('在 search_images 之后误调静默工具 reply_with_followup 被拦截时不推送也不保存内部工具步骤，且 actionDisplay 正确映射图标与尾标', async () => {
    const streamed: Array<{ kind: string; tool?: string }> = []
    script.push(
      {
        tool_calls: [{ id: 's-ok', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['热注入基础'], contrast: [] }) } }]
      },
      {
        tool_calls: [{ id: 'rwf-blocked', type: 'function', function: { name: 'reply_with_followup', arguments: JSON.stringify({ answer: 'hi', suggestion: 'next' }) } }]
      },
      { content: '好呀，图片我已经帮你翻出来啦~' }
    )

    const q = await ask({ conversationId: null, text: '找热注入基础的图', scope: { kind: 'organized' }, includeR18: false })
    const reply = await answer(q.conversation.id, undefined, (ev) => streamed.push({ kind: ev.kind, tool: ev.tool }))

    expect(streamed.some((e) => e.tool === 'reply_with_followup')).toBe(false)
    expect(reply.blocks?.some((b) => b.type === 'action' && b.tool === 'reply_with_followup')).toBe(false)
    expect(reply.text).toBe('好呀，图片我已经帮你翻出来啦~')

    expect(actionIconPath('get_image')).toBe(ACTION_ICON.eye)
    expect(actionIconPath('read_referenced_images')).toBe(ACTION_ICON.eye)
    expect(actionIconPath('search_similar_image')).toBe(ACTION_ICON.eye)
    expect(actionIconPath('propose_category_change')).toBe(ACTION_ICON.command)
    expect(actionIconPath('search_images')).toBe(ACTION_ICON.search)
    expect(splitActionSummary('检索图库：白露 · 1 张')).toEqual({ label: '检索图库：白露', meta: '1 张' })
    expect(splitActionSummary('核对类目录')).toEqual({ label: '核对类目录', meta: '' })
    expect(
      visibleTimelineBlocks([
        { type: 'action', id: '1', tool: 'search_images', summary: '检索图库 · 1 张', status: 'done' },
        { type: 'action', id: '2', tool: 'reply_with_followup', summary: '执行 reply_with_followup', status: 'failed' }
      ]).map((b) => (b.type === 'action' ? b.tool : b.type))
    ).toEqual(['search_images'])
  })

  it('同一步并行多路 search_images 时，后返回的 0 张不覆盖先命中的图片，且多路不同命中自动去重合并', async () => {
    const { pg } = getDatabase()
    await pg.exec('UPDATE image SET delete_state = 1 WHERE delete_state = 0')
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name, thumb_ready) VALUES
        ('merge-a', 'PNG', 10, '粉发猫耳A', 1),
        ('merge-b', 'PNG', 10, '粉发兽耳B', 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, 1, '二次元/' || content_hash || '.png', now() FROM image WHERE content_hash IN ('merge-a', 'merge-b');
      INSERT INTO tag (name, category_id) VALUES ('粉发猫耳路线', 4), ('粉发兽耳路线', 4) ON CONFLICT DO NOTHING;
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT i.id, t.id, 'MANUAL', 'ACCEPTED' FROM image i JOIN tag t ON
          (i.content_hash = 'merge-a' AND t.name = '粉发猫耳路线')
          OR (i.content_hash = 'merge-b' AND t.name = '粉发兽耳路线');
    `)

    // 场景 A：第 1 路命中 1 张，第 2 路 0 张 -> 仍保留第 1 路的 1 张卡片
    script.push(
      {
        tool_calls: [
          { id: 'p-hit', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['粉发猫耳路线'], contrast: [] }) } },
          { id: 'p-miss', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['不存在的路线'], contrast: [] }) } }
        ]
      },
      { content: '翻了一圈，找到一张粉发猫耳图给你看看~' }
    )
    const q1 = await ask({ conversationId: null, text: '找粉发猫耳和兽耳图', scope: null, includeR18: false })
    const r1 = await answer(q1.conversation.id)
    expect(r1.images.map((i) => i.name)).toEqual(['粉发猫耳A'])
    expect(r1.how).toContain('找到 1 张')

    // 场景 B：同一步两路各自命中不同图片 -> 去重合并返回两张卡片
    script.push(
      {
        tool_calls: [
          { id: 'm-1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['粉发猫耳路线'], contrast: [] }) } },
          { id: 'm-2', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['粉发兽耳路线'], contrast: [] }) } }
        ]
      },
      { content: '两路加起来一共有这两张呀~' }
    )
    const q2 = await ask({ conversationId: null, text: '把两条粉发兽耳路线都搜一遍', scope: null, includeR18: false })
    const r2 = await answer(q2.conversation.id)
    expect(r2.images.map((i) => i.name).sort()).toEqual(['粉发猫耳A', '粉发兽耳B'].sort())
    expect(r2.how).toContain('找到 2 张')
  })

  it('调用工具前的第三人称思考独白会被流式屏蔽且不会固化进 blocks.narration', async () => {
    const events: Array<{ kind: string; text?: string }> = []
    script.push(
      {
        content: '用户说"都给我看看"，承接上一轮推荐的类似图（普拉娜#84、爱丽丝#71），想看这些图。需要检索粉发兽耳娘类的图，并排除已展示过的（#93、#86）。',
        tool_calls: [
          { id: 'cot-1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['粉发猫耳路线'], contrast: [] }) } }
        ]
      },
      { content: '喏，这张就是你要找的图啦~' }
    )

    const q = await ask({ conversationId: null, text: '都给我看看', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id, undefined, (ev) => events.push({ kind: ev.kind, text: ev.text }))

    expect(events.some((e) => (e.kind === 'delta' || e.kind === 'narration_commit') && (e.text ?? '').includes('需要检索'))).toBe(false)
    expect(reply.blocks?.some((b) => b.type === 'narration')).toBe(false)
    expect(reply.images.map((i) => i.name)).toEqual(['粉发猫耳A'])
    expect(reply.text).toBe('喏，这张就是你要找的图啦~')
  })

  it('未调用 search_images 就输出「找到啦！这几张……」或编造未展示 #编号时触发系统纠偏重搜，返回真实卡片', async () => {
    const events: Array<{ kind: string; text?: string }> = []
    script.push(
      { content: '找到啦！这几张都是粉发兽耳娘路线，软萌度爆表\n- 普拉娜 (#99984): 粉长发+兽耳' },
      {
        tool_calls: [
          { id: 'fix-1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ tags: ['粉发猫耳路线'], contrast: [] }) } }
        ]
      },
      { content: '翻了一遍图库，其实符合条件的是这一张呀~' }
    )

    const q = await ask({ conversationId: null, text: '类似的图还有吗', scope: null, includeR18: false })
    const reply = await answer(q.conversation.id, undefined, (ev) => events.push({ kind: ev.kind, text: ev.text }))

    expect(events.some((e) => e.kind === 'reset')).toBe(true)
    expect(reply.images.map((i) => i.name)).toEqual(['粉发猫耳A'])
    expect(reply.text).toBe('翻了一遍图库，其实符合条件的是这一张呀~')
    expect(reply.text).not.toContain('#99984')
  })

  it('动态角色心境状态机能识别 5 种语境与纯斗嘴反回拉，节流口癖复读，并在第④层注入首轮边界而不破坏缓存前缀', async () => {
    expect(detectPersonaStance('最喜欢你了')).toBe('flustered')
    expect(detectPersonaStance('今天加班好累呀')).toBe('gentle')
    expect(detectPersonaStance('杂鱼')).toBe('pouting')
    expect(detectPersonaStance('臭杂鱼')).toBe('pouting')
    expect(detectPersonaStance('小鬼别太嚣张了')).toBe('pouting')
    expect(detectPersonaStance('帮我写一段 TypeScript 代码')).toBe('focused')
    expect(detectPersonaStance('帮我找几张可爱猫娘图')).toBe('teasing')

    expect(isPureBanter('臭杂鱼')).toBe(true)
    expect(isPureBanter('帮我找几张猫娘图')).toBe(false)

    const banterCue = buildPersonaCue('臭杂鱼')
    expect(banterCue).toContain('互损斗嘴')
    expect(banterCue).toContain('[反回拉]')

    const flusteredCue = buildPersonaCue('最喜欢你了', [
      '哼，杂鱼连这点都要我找，勉强给你看看喵～',
      '杂鱼真是拿你没办法，喏 ฅ^•ﻌ•^ฅ'
    ])
    expect(flusteredCue).toContain('被直球戳中')
    expect(flusteredCue).toContain('杂鱼')
    expect(flusteredCue).toContain('纯文字自然收尾')

    const openCue = buildPersonaCue('还有吗', ['啊？你才刚说完嘛'])
    expect(openCue).toContain('啊？')

    // 验证实际对话流中：首轮带 [新对话开场]、次轮省略；不同心境只改第④层，第①②层与少样本前缀字节完全不变
    script.push({ content: '啊？你别突然来这套行不行，真的，耳朵都要热了' }, { content: '行吧，累了就先歇着，别硬扛。' })
    const q = await ask({ conversationId: null, text: '最喜欢你了', scope: null, includeR18: false })
    await answer(q.conversation.id)
    const firstMsgs = calls.at(-1)!.messages as Array<{ role: string; content: unknown }>
    const prefixLen = 1 + PERSONA_FEW_SHOT_MESSAGES.length
    expect(firstMsgs.slice(1, prefixLen).map((m) => m.role)).toEqual(PERSONA_FEW_SHOT_MESSAGES.map((m) => m.role))
    const firstTail = String((firstMsgs.at(-2) as { content?: unknown })?.content ?? '')
    expect(firstTail).toContain('[新对话开场]')
    expect(firstTail).toContain('被直球戳中')

    await ask({ conversationId: q.conversation.id, text: '今天好累呀', scope: null, includeR18: false })
    await answer(q.conversation.id)
    const secondMsgs = calls.at(-1)!.messages as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(secondMsgs.slice(0, prefixLen))).toBe(JSON.stringify(firstMsgs.slice(0, prefixLen)))
    const secondTail = String((secondMsgs.at(-2) as { content?: unknown })?.content ?? '')
    expect(secondTail).not.toContain('[新对话开场]')
    expect(secondTail).toContain('嘴硬心软')
  })

  it('web_search 走 Qwen 过滤摘要且使用地球 SVG 图标；分片 <think> 与中途思考泄露触发 clear_stream', async () => {
    expect(actionIconPath('web_search')).toBe(ACTION_ICON.globe)
    expect(isPureBanter('联网查一下今天有什么新闻')).toBe(false)

    const anchorCue = buildPersonaCue('说！这个是不是你', [], { turnCount: 7, compacted: true })
    expect(anchorCue).toContain('[诺诺核心锚点]')
    expect(anchorCue).toContain('白发紫瞳')

    // 1. web_search 工具动作块 + 地球图标归属
    script.push(
      { tool_calls: [{ id: 'ws1', type: 'function', function: { name: 'web_search', arguments: '{"query":"阿罗娜 设定"}' } }] },
      { content: '她啊，是夏莱的AI管理员，和你一样是个麻烦家伙。' }
    )
    const wsQ = await ask({ conversationId: null, text: '联网查一下阿罗娜设定', scope: null, includeR18: false })
    const wsReply = await answer(wsQ.conversation.id)
    expect(wsReply.blocks).toEqual([
      { type: 'action', id: 's0-0-ws1', tool: 'web_search', summary: '联网搜索：阿罗娜 设定 · 1 条来源', status: 'done' }
    ])
    expect(wsReply.text).toContain('夏莱')

    // 2. 分片 <think>...</think> 流式吞掉（不吐出任何 think delta）
    const thinkEvents: Array<{ kind: string; text?: string }> = []
    script.push({
      onCall: async ({ onDelta }) => {
        for (const chunk of ['<thi', 'nk>先偷偷想一', '想</th', 'ink>啊？', '真拿你', '没办法']) {
          onDelta?.(chunk)
        }
        return { content: '<think>先偷偷想一想</think>啊？真拿你没办法' }
      }
    })
    const qThink = await ask({ conversationId: null, text: '帮我看看这个', scope: null, includeR18: false })
    const rThink = await answer(qThink.conversation.id, undefined, (ev) => thinkEvents.push({ kind: ev.kind, text: ev.text }))
    const streamedJoin = thinkEvents.filter((e) => e.kind === 'delta').map((e) => e.text ?? '').join('')
    expect(streamedJoin).toBe('啊？真拿你没办法')
    expect(streamedJoin).not.toContain('偷偷想')
    expect(rThink.text).toBe('啊？真拿你没办法')

    // 3. 中途出现工具规划思考泄露时立即推送 clear_stream 抹除闪烁残影
    const leakEvents: Array<{ kind: string; text?: string }> = []
    script.push({
      onCall: async ({ onDelta }) => {
        onDelta?.('先看下情况，')
        onDelta?.('然后需要调用 search_images 来检索')
        return {
          content: '先看下情况，然后需要调用 search_images 来检索',
          tool_calls: [{ id: 'lk1', type: 'function', function: { name: 'list_tags', arguments: '{}' } }]
        }
      }
    })
    script.push({ content: '标签就这几个。' })
    const qLeak = await ask({ conversationId: null, text: '标签都有啥', scope: null, includeR18: false })
    const rLeak = await answer(qLeak.conversation.id, undefined, (ev) => leakEvents.push({ kind: ev.kind, text: ev.text }))
    expect(leakEvents.some((e) => e.kind === 'clear_stream')).toBe(true)
    expect(rLeak.blocks?.some((b) => b.type === 'narration')).toBe(false)
    expect(rLeak.text).toBe('标签就这几个。')
  })

  it('图库引用仅对非 R-18 过审图附带视觉画面，且对话压缩后 listMessages 标记 compactedAfter', async () => {
    const { pg } = getDatabase()
    const rootRes = await pg.query<{ path: string }>("SELECT path FROM library_root WHERE id = 1")
    const libDir = rootRes.rows[0].path
    mkdirSync(join(libDir, '二次元'), { recursive: true })
    const pinkBuf = await sharp({ create: { width: 48, height: 48, channels: 3, background: '#ff9ec4' } }).png().toBuffer()
    const { createHash } = await import('node:crypto')
    const pinkHash = createHash('sha256').update(pinkBuf).digest('hex')
    const r18Hash = createHash('sha256').update(Buffer.from('r18-pixel-guard')).digest('hex')
    writeFileSync(join(libDir, '二次元', 'ref-pink.png'), pinkBuf)

    const inserted = await pg.query<{ id: number; content_hash: string }>(
      `INSERT INTO image (content_hash, format, byte_size, width, height, display_name, is_r18, rating_source, rating, thumb_ready) VALUES
        ($1, 'PNG', $2, 48, 48, '粉发引用图', false, 'MANUAL', 'GENERAL', 1),
        ($3, 'PNG', 10, 48, 48, '受限引用图', true, 'MANUAL', 'EXPLICIT', 1)
       RETURNING id, content_hash`,
      [pinkHash, pinkBuf.length, r18Hash]
    )
    const pinkId = inserted.rows.find((r) => r.content_hash === pinkHash)!.id
    const r18Id = inserted.rows.find((r) => r.content_hash === r18Hash)!.id
    await pg.query(
      `INSERT INTO image_file (image_id, root_id, rel_path, mtime, status) VALUES
        ($1, 1, '二次元/ref-pink.png', now(), 'NORMAL'),
        ($2, 1, '二次元/ref-r18.png', now(), 'NORMAL')`,
      [pinkId, r18Id]
    )

    try {
      // 1. 非 R-18 过审引用图：消息尾部带上 image_url，模型真正看得到图
      script.push({ content: '粉毛可不是我，我白毛紫瞳。' })
      const qSafe = await ask({
        conversationId: null,
        text: '说！这个是不是你',
        scope: null,
        includeR18: false,
        references: [{ imageId: pinkId, position: 1, name: '粉发引用图', groupId: 'gallery:test' }]
      })
      await answer(qSafe.conversation.id)
      const sentSafe = JSON.stringify(calls.at(-1)!.messages)
      expect(sentSafe).toContain('"type":"image_url"')
      expect(sentSafe).toContain('data:image/jpeg;base64,')

      // 2. 压缩后 listMessages 正确返回 compactedAfter: true
      script.push({ content: '用户拿一张粉发图问是不是诺诺，诺诺澄清自己白发紫瞳。' })
      const compacted = await compactConversation(qSafe.conversation.id)
      expect(compacted.changed).toBe(true)
      const msgsAfterCompact = await listMessages(qSafe.conversation.id)
      expect(msgsAfterCompact.some((m) => m.role === 'assistant' && m.compactedAfter === true)).toBe(true)

      // 3. R-18 引用图：即使带文件记录，也绝不上云传像素
      script.push({ content: '仅按元数据讨论。' })
      const qR18 = await ask({
        conversationId: null,
        text: '给我起个标题',
        scope: null,
        includeR18: true,
        references: [{ imageId: r18Id, position: 1, name: '受限引用图', groupId: 'gallery:test' }]
      })
      await answer(qR18.conversation.id)
      expect(JSON.stringify(calls.at(-1)!.messages)).not.toMatch(/data:image|image_url/)
    } finally {
      await pg.query('DELETE FROM image_file WHERE image_id = ANY($1::bigint[])', [[pinkId, r18Id]])
      await pg.query('DELETE FROM image WHERE id = ANY($1::bigint[])', [[pinkId, r18Id]])
    }
  })

  it('R-18 开关关闭与开启时均严格隔离检索与标签可见性，且压缩返回真实 token 估算与非空 checkpoint', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO tag (name, category_id) VALUES ('R18专属测试', 4) ON CONFLICT DO NOTHING;
      INSERT INTO image (content_hash, format, byte_size, display_name, is_r18, thumb_ready) VALUES
        ('r18-only-a', 'PNG', 10, '受限专属图A', true, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime, status)
        SELECT id, 1, '二次元/r18-only-a.png', now(), 'NORMAL' FROM image WHERE content_hash = 'r18-only-a';
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT i.id, t.id, 'MANUAL', 'ACCEPTED' FROM image i JOIN tag t ON i.content_hash = 'r18-only-a' AND t.name = 'R18专属测试';
    `)

    try {
      // 1. R-18 关闭时：onlyR18: true 被直接拒绝（r18SwitchOff），R18 专属标签检索 0 命中
      script.push(
        { tool_calls: [{ id: 'r-off-1', type: 'function', function: { name: 'search_images', arguments: '{"onlyR18":true,"contrast":[]}' } }] },
        { content: '没开 R-18 开关我看不到哦，自己把下面开关打开嘛。' }
      )
      const qOff1 = await ask({ conversationId: null, text: '看看 R-18 的图', scope: null, includeR18: false })
      const rOff1 = await answer(qOff1.conversation.id)
      expect(rOff1.images).toEqual([])
      const offTool1 = JSON.parse(
        String((calls.at(-1)!.messages as Array<{ role: string; content: string }>).findLast((m) => m.role === 'tool')?.content ?? '{}')
      )
      expect(offTool1.r18SwitchOff).toBe(true)

      script.push(
        { tool_calls: [{ id: 'r-off-2', type: 'function', function: { name: 'search_images', arguments: '{"tags":["R18专属测试"],"contrast":[]}' } }] },
        { content: '没找到这类图呢。' }
      )
      const qOff2 = await ask({ conversationId: null, text: '搜 R18专属测试', scope: null, includeR18: false })
      const rOff2 = await answer(qOff2.conversation.id)
      expect(rOff2.images).toEqual([])

      // 2. R-18 开启时：onlyR18: true 与 R18 专属标签均能准确命中且绝不附带像素给云端
      script.push(
        { tool_calls: [{ id: 'r-on-1', type: 'function', function: { name: 'search_images', arguments: '{"onlyR18":true,"contrast":[]}' } }] },
        { content: '给，都在下面卡片里了，别乱看太久。' }
      )
      const qOn1 = await ask({ conversationId: null, text: '看看我的 R-18 图', scope: null, includeR18: true })
      const rOn1 = await answer(qOn1.conversation.id)
      expect(rOn1.images.map((i) => i.name)).toContain('受限专属图A')
      expect(rOn1.how).toContain('分级「R-18」')
      expect(JSON.stringify(calls.at(-1)!.messages)).not.toMatch(/data:image|image_url/)

      script.push(
        { tool_calls: [{ id: 'r-on-2', type: 'function', function: { name: 'search_images', arguments: '{"tags":["R18专属测试"],"contrast":[]}' } }] },
        { content: '找到这张啦。' }
      )
      const qOn2 = await ask({ conversationId: qOn1.conversation.id, text: '找 R18专属测试 的图', scope: null, includeR18: true })
      const rOn2 = await answer(qOn2.conversation.id)
      expect(rOn2.images.map((i) => i.name)).toEqual(['受限专属图A'])

      // 3. 插入一条空正文末轮回复后执行手动压缩：仍能绑定到最后被压缩轮的 checkpoint 且使用真实 token 估算
      await pg.query("INSERT INTO ai_message (conversation_id, role, content) VALUES ($1, 'USER', $2)", [
        qOn2.conversation.id,
        JSON.stringify({ text: '再补一句', scope: null, includeR18: false })
      ])
      await pg.query("INSERT INTO ai_message (conversation_id, role, content) VALUES ($1, 'ASSISTANT', $2)", [
        qOn2.conversation.id,
        JSON.stringify({ text: '', how: null, imageIds: [] })
      ])
      script.push({ content: '用户查看了 R-18 测试图，诺诺按条件返回结果。' })
      const compactRes = await compactConversation(qOn2.conversation.id)
      expect(compactRes.changed).toBe(true)
      expect(compactRes.checkpoint).not.toBeNull()
      expect(compactRes.checkpoint!.usage.compacted).toBe(true)
      expect(compactRes.checkpoint!.usage.usedTokens).toBeLessThan(10_000)
      const listed = await listMessages(qOn2.conversation.id)
      expect(listed.some((m) => m.id === compactRes.checkpoint!.messageId && m.compactedAfter === true)).toBe(true)
    } finally {
      await pg.exec(`
        DELETE FROM image_tag WHERE image_id IN (SELECT id FROM image WHERE content_hash = 'r18-only-a');
        DELETE FROM image_file WHERE image_id IN (SELECT id FROM image WHERE content_hash = 'r18-only-a');
        DELETE FROM image WHERE content_hash = 'r18-only-a';
        DELETE FROM tag WHERE name = 'R18专属测试';
      `)
    }
  })
})
