import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { aiEvent, aiJob, aiProfile } from '../../src/main/db/schema'
import { findRecentUsage, insertApiUsage } from '../../src/main/repositories/apiUsageRepository'
import { checkHitRate } from '../../src/main/services/ai/bailianClient'
import { assertCacheMarks, buildMessages, countCacheMarks, stableStringify } from '../../src/main/services/ai/promptPrefix'
import { collectSearchSources, keepToolSources } from '../../src/main/services/ai/searchSources'
import { normalizeChatUsage, normalizeResponsesUsage, textHitRate } from '../../src/main/services/ai/usage'

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

  it('标记超过上限直接报错', () => {
    const mark = { type: 'ephemeral' as const }
    const msgs = [1, 2, 3].map(() => ({ role: 'user' as const, content: [{ type: 'text' as const, text: 'x', cache_control: mark }] }))
    expect(() => assertCacheMarks(msgs)).toThrow()
  })

  it('键序不同的对象序列化结果相同，数组顺序保留', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: 0 } })).toBe(stableStringify({ a: { c: 0, d: [2, 1] }, b: 1 }))
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })
})

describe('用量统一', () => {
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
})
