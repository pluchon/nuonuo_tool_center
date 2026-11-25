import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'

function unitVec(a: number, b: number, c = 0): number[] {
  const v = new Array(1024).fill(0)
  v[0] = a
  v[1] = b
  v[2] = c
  return v
}

vi.mock('../../src/main/services/ai/embeddingClient', () => ({
  embed: vi.fn(async (input: { text?: string }) => {
    const t = input.text ?? ''
    if (t.includes('海边') || t.includes('蔚蓝')) return unitVec(1, 0, 0)
    if (t.includes('雪山') || t.includes('冬景')) return unitVec(0, 1, 0)
    if (t.includes('失败')) throw new Error('模拟网络失败')
    return unitVec(0, 0, 1)
  })
}))

const { embed } = await import('../../src/main/services/ai/embeddingClient')
const {
  addImageExclusion,
  excludedImageIds,
  findMemoriesNeedingEmbedding,
  removeImageExclusion,
  saveMemoryEmbedding
} = await import('../../src/main/repositories/aiMemoryRepository')
const {
  findCompactionsByConversation,
  findRecalledMessage,
  insertConversation,
  insertMemory,
  insertMessage,
  reviseLastUserMessage,
  saveCompactionForMessage
} = await import('../../src/main/repositories/aiConversationRepository')
const {
  cachedSearchValue,
  flushExpiredSearchCache,
  searchCacheKey
} = await import('../../src/main/repositories/aiSearchCacheRepository')
const { backfillMemoryEmbeddings } = await import('../../src/main/services/ai/embeddingService')
const { relevantMemories } = await import('../../src/main/services/ai/memoryRetrieval')

describe('Phase B Part 2: exclusion, draft, compaction, pgvector memory, search cache', () => {
  let dir: string
  const savedKey = process.env.DASHSCOPE_API_KEY

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-memvec-'))
    process.env.DASHSCOPE_API_KEY = 'test-memvec'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    await getDatabase().pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name) VALUES
        ('mv-1', 'PNG', 10, '海滩图'),
        ('mv-2', 'PNG', 10, '雪山图');
    `)
  })

  afterAll(async () => {
    await closeDatabase()
    if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = savedKey
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.mocked(embed).mockClear()
  })

  it('ai_image_exclusion 持久化幂等，且撤回/编辑对应消息时回滚排除与摘要和记忆', async () => {
    const conv = await insertConversation('排除回滚测试', null)
    const userMsg = await insertMessage(conv.id, 'USER', { text: '以后不要海滩图' })
    const assistantMsg = await insertMessage(conv.id, 'ASSISTANT', { text: '记住了' })

    await addImageExclusion(1, userMsg.id)
    await addImageExclusion(1, userMsg.id) // onConflictDoNothing 幂等
    await addImageExclusion(2, null)
    expect(await excludedImageIds()).toEqual(new Set([1, 2]))

    await insertMemory('偏爱晴天海景', 'preference', 0.9, userMsg.id)
    expect(await saveCompactionForMessage(assistantMsg.id, '阶段摘要', 1234)).toBe(true)
    expect(await findCompactionsByConversation(conv.id)).toHaveLength(1)

    // 撤回该用户消息 -> draft 落库 ai_conversation.draft，关联排除/记忆/摘要全部回滚
    const recalled = await reviseLastUserMessage(conv.id, userMsg.id)
    expect(recalled.id).toBe(userMsg.id)
    expect(await excludedImageIds()).toEqual(new Set([2]))
    expect(await findCompactionsByConversation(conv.id)).toEqual([])
    const draft = await findRecalledMessage(conv.id)
    expect(draft?.id).toBe(userMsg.id)
    expect(draft?.content).toEqual({ text: '以后不要海滩图' })

    const activeMem = await getDatabase().pg.query('SELECT id FROM ai_memory WHERE source_message_id = $1 AND valid_to IS NULL', [userMsg.id])
    expect(activeMem.rows).toHaveLength(0)

    // 发送新消息后清空 draft
    await insertMessage(conv.id, 'USER', { text: '新提问' })
    expect(await findRecalledMessage(conv.id)).toBeUndefined()

    await removeImageExclusion(2)
    expect(await excludedImageIds()).toEqual(new Set())
  })

  it('ai_memory 无向量时不调 embed，有向量时按 pgvector 余弦相似度跨零字面重合排序', async () => {
    const { pg } = getDatabase()
    // 1. 无向量阶段：零调用 embed，按二元组重合度工作
    await pg.exec(`
      INSERT INTO ai_memory (content, kind, confidence) VALUES
        ('喜欢蔚蓝海岸风景', 'fact', 0.9),
        ('不喜欢冬景积雪', 'fact', 0.9);
    `)
    const noVecRes = await relevantMemories('海岸')
    expect(noVecRes.map((m) => m.content)).toEqual(['喜欢蔚蓝海岸风景'])
    expect(embed).not.toHaveBeenCalled()

    // 2. 插入一条来自 R-18 事件的记忆，确保 backfill 跳过它
    const { rows: [r18Ev] } = await pg.query<{ id: number }>(
      "INSERT INTO ai_event (kind, payload, is_r18) VALUES ('test', '{}'::jsonb, true) RETURNING id"
    )
    await pg.query(
      "INSERT INTO ai_memory (content, kind, confidence, source_event_id) VALUES ('R18来源记忆', 'fact', 0.9, $1)",
      [r18Ev.id]
    )

    const needing = await findMemoriesNeedingEmbedding(20)
    expect(needing.some((m) => m.content === 'R18来源记忆')).toBe(false)

    // 3. 补全向量后：查询 '海边'（与 '喜欢蔚蓝海岸风景' 零二元字面重合）命中语义第一
    const filled = await backfillMemoryEmbeddings(10)
    expect(filled).toBe(2)
    expect(embed).toHaveBeenCalledTimes(2)

    vi.mocked(embed).mockClear()
    const semanticRes = await relevantMemories('海边')
    expect(semanticRes[0]?.content).toBe('喜欢蔚蓝海岸风景')
    expect(embed).toHaveBeenCalledTimes(1)

    // 4. 查询向量失败时无缝降级回二元组重合度
    const fallbackRes = await relevantMemories('积雪失败测试')
    expect(fallbackRes[0]?.content).toBe('不喜欢冬景积雪')

    // 5. 手工 saveMemoryEmbedding 写入后可用
    const rows = await pg.query<{ id: number }>("SELECT id FROM ai_memory WHERE content = '喜欢蔚蓝海岸风景'")
    await saveMemoryEmbedding(rows.rows[0].id, unitVec(1, 0, 0))

    await pg.exec('DELETE FROM ai_memory')
    await pg.exec('DELETE FROM ai_event')
  })

  it('stableStringify 保证键序无关命中，ai_search_cache 惰性清理过期记录', async () => {
    const k1 = searchCacheKey('plan', { b: 2, a: { y: true, x: [1, 2] } })
    const k2 = searchCacheKey('plan', { a: { x: [1, 2], y: true }, b: 2 })
    expect(k1).toBe(k2)

    const { pg } = getDatabase()
    await pg.exec("INSERT INTO ai_search_cache (key, value, expires_at) VALUES ('lazy-expired', '\"old\"'::jsonb, now() - interval '1 minute')")
    const valid = (v: unknown): v is string => typeof v === 'string'
    await cachedSearchValue(searchCacheKey('lazy', { id: 1 }), valid, async () => 'fresh-1')
    expect((await pg.query("SELECT 1 FROM ai_search_cache WHERE key = 'lazy-expired'")).rows).toHaveLength(0)

    await pg.exec("INSERT INTO ai_search_cache (key, value, expires_at) VALUES ('flush-expired', '\"old2\"'::jsonb, now() - interval '1 minute')")
    expect(await flushExpiredSearchCache()).toBeGreaterThanOrEqual(1)
    expect((await pg.query("SELECT 1 FROM ai_search_cache WHERE key = 'flush-expired'")).rows).toHaveLength(0)
  })
})
