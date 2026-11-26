import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { aiEvent, aiJob, aiProfile, apiUsage } from '../../src/main/db/schema'
import { findRecentUsage, insertApiUsage } from '../../src/main/repositories/apiUsageRepository'
import { checkHitRate, searchCall } from '../../src/main/services/ai/bailianClient'
import { embed } from '../../src/main/services/ai/embeddingClient'
import { EMBEDDING_CONFIG } from '../../src/main/config/cloudConfig'
import { assertCacheMarks, buildMessages, countCacheMarks, markStepCache, stableStringify } from '../../src/main/services/ai/promptPrefix'
import { collectSearchSources, keepToolSources } from '../../src/main/services/ai/searchSources'
import { normalizeChatUsage, normalizeResponsesUsage, reportedChatCache, textHitRate } from '../../src/main/services/ai/usage'

const MIGRATIONS = resolve('drizzle')

describe('四层前缀', () => {
  const history = [
    { role: 'user' as const, content: '找甘雨' },
    { role: 'assistant' as const, content: '找到 3 张' }
  ]
  const tail = [{ role: 'user' as const, content: '现在时间 10:00\n再找竖图' }]

  it('打缓存时：①② 合成一条 system 带标记，③ 最后一条带标记，④ 不带', () => {
    const msgs = buildMessages({ rules: '规则', profile: '档案', history, tail, cache: true })
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs[0].content).toEqual([{ type: 'text', text: '规则\n\n档案', cache_control: { type: 'ephemeral' } }])
    expect(msgs[2].content).toEqual([{ type: 'text', text: '找到 3 张', cache_control: { type: 'ephemeral' } }])
    expect(msgs[3].content).toBe(tail[0].content)
    expect(countCacheMarks(msgs)).toBe(2)
    // 原历史不被改动
    expect(history[1].content).toBe('找到 3 张')
  })

  it('不打缓存时没有任何标记；没有历史时只标 system', () => {
    expect(countCacheMarks(buildMessages({ rules: 'r', profile: '', history, tail, cache: false }))).toBe(0)
    const msgs = buildMessages({ rules: 'r', profile: '', history: [], tail, cache: true })
    expect(countCacheMarks(msgs)).toBe(1)
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'r', cache_control: { type: 'ephemeral' } }])
  })

  it('同样的前缀原料两次拼出完全相同的前缀', () => {
    const a = buildMessages({ rules: 'r', profile: 'p', history, tail: [{ role: 'user', content: '1' }], cache: true })
    const b = buildMessages({ rules: 'r', profile: 'p', history, tail: [{ role: 'user', content: '2' }], cache: true })
    expect(JSON.stringify(a.slice(0, 3))).toBe(JSON.stringify(b.slice(0, 3)))
  })

  it('标记超过上限直接报错；多步工具循环只推进 user 断点，tool 保持纯文本', () => {
    const mark = { type: 'ephemeral' as const }
    const msgs = [1, 2, 3, 4, 5].map(() => ({ role: 'user' as const, content: [{ type: 'text' as const, text: 'x', cache_control: mark }] }))
    expect(() => assertCacheMarks(msgs)).toThrow()

    const base = buildMessages({
      rules: '规则',
      profile: '档案',
      history,
      tail: [
        { role: 'user', content: '查图' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
        { role: 'tool', tool_call_id: 't1', content: '{"total":1}' }
      ],
      cache: true
    })
    const step1 = markStepCache(base)
    expect(countCacheMarks(step1)).toBe(3)
    expect(step1[3].content).toEqual([{ type: 'text', text: '查图', cache_control: mark }])
    expect(step1[5].content).toBe('{"total":1}')
    const step2 = markStepCache([
      ...step1,
      { role: 'assistant', content: '', tool_calls: [{ id: 't2' }] },
      { role: 'tool', tool_call_id: 't2', content: '{"total":2}' }
    ])
    expect(countCacheMarks(step2)).toBe(4)
    expect(step2[1].content).toEqual([{ type: 'text', text: '找甘雨', cache_control: mark }])
    expect(step2[5].content).toBe('{"total":1}')
    expect(step2[7].content).toBe('{"total":2}')
    // 达到 4 个上限不再追加
    const fourMarked = [1, 2, 3, 4].map(() => ({ role: 'user' as const, content: [{ type: 'text' as const, text: 'ok', cache_control: mark }] }))
    expect(countCacheMarks(markStepCache([...fourMarked, { role: 'user', content: 'tail' }]))).toBe(4)
  })

  it('键序不同的对象序列化结果相同，数组顺序保留', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: 0 } })).toBe(stableStringify({ a: { c: 0, d: [2, 1] }, b: 1 }))
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })
})

describe('用量统一', () => {
  it('回复只使用完整的百炼缓存统计，区分未报告与实际零命中', () => {
    const report = (input: number, cached?: number) => reportedChatCache({ prompt_tokens: input, prompt_tokens_details: { cached_tokens: cached } })
    expect(report(3019, 2048)).toEqual({ inputTokens: 3019, cachedTokens: 2048 })
    expect(report(10, 0)).toEqual({ inputTokens: 10, cachedTokens: 0 })
    for (const usage of [report(0, 0), report(10), report(10, 11), report(10, -1), reportedChatCache(undefined)]) expect(usage).toBeUndefined()
  })

  // 下面两段是 2026-11-22 实测返回的结构
  it('Chat Completions：命中、写入、图片 token', () => {
    expect(
      normalizeChatUsage({
        prompt_tokens: 6012,
        completion_tokens: 147,
        prompt_tokens_details: { cached_tokens: 5997, cache_creation_input_tokens: 0, text_tokens: 6012 }
      })
    ).toEqual({ inputTokens: 6012, cachedTokens: 5997, cacheWriteTokens: 0, imageTokens: 0, outputTokens: 147, searchCount: 0 })
    expect(normalizeChatUsage({ prompt_tokens: 426, completion_tokens: 31, prompt_tokens_details: { image_tokens: 386 } }).imageTokens).toBe(386)
  })

  it('Responses：图片 token 在 x_details，联网次数在 x_tools', () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 3538,
        input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
        output_tokens: 338,
        x_details: [{ input_tokens_details: { image_tokens: 772, text_tokens: 2766 } }],
        x_tools: { web_search: { count: 1 } }
      })
    ).toEqual({ inputTokens: 3538, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 772, outputTokens: 338, searchCount: 1 })
  })

  it('缺字段时当 0，不抛错', () => {
    expect(normalizeChatUsage(undefined).inputTokens).toBe(0)
    expect(normalizeResponsesUsage(null).searchCount).toBe(0)
  })

  it('兼容 Responses 新旧计费字段，避免重复加计图片和搜索', () => {
    const usage = normalizeResponsesUsage({
      input_tokens: 2800,
      output_tokens: 200,
      prompt_tokens_details: { cached_tokens: 1200, cache_creation_input_tokens: 150 },
      x_details: [{ image_tokens: 500, input_tokens_details: { image_tokens: 500 } }],
      x_tools: { web_search: { count: 1 } }
    }, { web_search: { num_requests: 1 } })
    expect(usage).toEqual({ inputTokens: 2800, cachedTokens: 1200, cacheWriteTokens: 150, imageTokens: 500, outputTokens: 200, searchCount: 1 })
  })

  it('命中率按文本 token 算，图片不进分母', () => {
    expect(textHitRate([{ inputTokens: 1386, cachedTokens: 950, imageTokens: 386 }])).toBeCloseTo(0.95)
    expect(textHitRate([{ inputTokens: 0, cachedTokens: 0, imageTokens: 0 }])).toBeNull()
  })
})

describe('搜索来源', () => {
  const output = [
    { type: 'reasoning' },
    {
      type: 'web_search_call',
      action: { sources: [{ type: 'url', url: 'https://wiki.biligame.com/ys/x' }, { url: 'https://x.com/a' }, { url: 'https://x.com/a' }, { url: 'javascript:alert(1)' }] }
    },
    { type: 'message' }
  ]

  it('只取搜索工具返回的 http 链接并去重', () => {
    expect(collectSearchSources(output)).toEqual([{ url: 'https://wiki.biligame.com/ys/x' }, { url: 'https://x.com/a' }])
    expect(collectSearchSources(undefined)).toEqual([])
  })

  it('模型自己写的链接不在来源里就丢掉', () => {
    expect(keepToolSources(['https://x.com/a', 'https://www.bilibili.com/blackboard/made-up.html'], collectSearchSources(output))).toEqual([
      'https://x.com/a'
    ])
  })
})

describe('AI 表和记账', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-ai-'))
    await openDatabase(join(dir, 'pgdata'), MIGRATIONS)
  })

  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('新表能写能读，档案版本唯一', async () => {
    const { db } = getDatabase()
    await db.insert(aiProfile).values({ version: 1, content: '喜欢中文角色名', tagVocab: { 角色: ['甘雨'] } })
    await expect(db.insert(aiProfile).values({ version: 1, content: 'x', tagVocab: {} })).rejects.toThrow()
    await db.insert(aiEvent).values({ kind: 'rename', payload: { from: 'a', to: 'b' } })
    const [job] = await db.insert(aiJob).values({ kind: 'LOOK' }).returning()
    expect(job.status).toBe('QUEUED')
    expect(job.priority).toBe(0)
  })

  it('向量接口拒绝无效响应，限流不自动重试，恢复后只记录一次成功', async () => {
    const send = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', send)
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture')
    const vector = Array<number>(EMBEDDING_CONFIG.dimension).fill(0)
    const response = (embedding: unknown) => Response.json({ output: { embeddings: [{ embedding }] } })
    try {
      for (const invalid of [Response.json(null), response([]), response(vector), response(['1', ...vector.slice(1)]),
        response([1e200, ...vector.slice(1)])]) {
        send.mockResolvedValueOnce(invalid)
        await expect(embed({ text: '配色' })).rejects.toThrow('无效向量')
      }
      send.mockResolvedValueOnce(Response.json({ code: 'TooManyRequests' }, { status: 429 }))
      await expect(embed({ text: '配色' })).rejects.toThrow('429')
      vector[0] = 1
      send.mockResolvedValueOnce(response(vector))
      expect(await embed({ text: '配色' })).toEqual(vector)
      expect(send).toHaveBeenCalledTimes(7)
      expect((await getDatabase().pg.query("select count(*)::int as total, count(error)::int as failed from api_usage where api='embed'")).rows)
        .toEqual([{ total: 7, failed: 6 }])
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('不够次数不算命中率；够了按文本 token 算，失败的调用不计入', async () => {
    for (let i = 0; i < 9; i++) {
      await insertApiUsage({ api: 'chat', model: 'm', inputTokens: 1000, cachedTokens: 990 })
    }
    expect(await checkHitRate('chat')).toBeNull()
    await insertApiUsage({ api: 'chat', model: 'm', error: '500 InternalServerError' })
    expect(await checkHitRate('chat')).toBeNull()
    await insertApiUsage({ api: 'chat', model: 'm', inputTokens: 1000, cachedTokens: 0 })
    expect(await checkHitRate('chat')).toBeCloseTo(0.891)
    expect((await findRecentUsage('chat', 20)).length).toBe(10)
  })

  it('批量和失败请求不会挤占实时缓存统计窗口', async () => {
    const { db } = getDatabase()
    await db.insert(apiUsage).values(Array.from({ length: 10 }, () => ({ api: 'look', inputTokens: 1000, imageTokens: 200, cachedTokens: 600 })))
    await db.insert(apiUsage).values(Array.from({ length: 25 }, () => ({ api: 'look', inputTokens: 1000, batch: true })))
    await insertApiUsage({ api: 'look', error: '请求失败' })
    expect(await checkHitRate('look')).toBeCloseTo(0.75)
  })

  it('searchCall 支持 SSE 流式响应保活并提取来源链接与用量', async () => {
    const encoder = new TextEncoder()
    const events = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', content_index: 0, delta: '{"name":"星辰"', item_id: 'm1', logprobs: [], output_index: 0, sequence_number: 1 })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', content_index: 0, delta: ',"tags":["星空"]}', item_id: 'm1', logprobs: [], output_index: 0, sequence_number: 2 })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        sequence_number: 3,
        response: {
          output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://example.com/art/1' }] } }],
          usage: { input_tokens: 120, output_tokens: 18, input_tokens_details: { cached_tokens: 40 } },
          tool_usage: { web_search: { num_requests: 1 } }
        }
      })}\n\n`
    ]
    const sseBody = new ReadableStream({
      start(controller) {
        for (const chunk of events) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    )
    vi.stubGlobal('fetch', send)
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture-sse')
    try {
      const res = await searchCall({
        kind: 'look',
        model: 'qwen3.8-flash',
        instructions: '识别图片',
        text: '看图'
      })
      expect(res.text).toBe('{"name":"星辰","tags":["星空"]}')
      expect(res.sources).toEqual([{ url: 'https://example.com/art/1' }])
      expect(res.usage).toMatchObject({ inputTokens: 120, cachedTokens: 40, outputTokens: 18, searchCount: 1 })
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })
})
