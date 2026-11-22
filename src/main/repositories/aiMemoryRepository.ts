import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { aiEvent, aiJob, aiMemory } from '../db/schema'

export type AiMemoryEntity = typeof aiMemory.$inferSelect
export type AiEventEntity = typeof aiEvent.$inferSelect

// 还有效的记忆（可信度高的在前）
export async function findValidMemories(limit = 200): Promise<AiMemoryEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(aiMemory)
    .where(and(eq(aiMemory.deleteState, 0), isNull(aiMemory.validTo)))
    .orderBy(desc(aiMemory.confidence), desc(aiMemory.id))
    .limit(limit)
}

// 按内容找一条还有效的记忆
export async function findValidMemoryByContent(content: string): Promise<AiMemoryEntity | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .select()
    .from(aiMemory)
    .where(and(eq(aiMemory.deleteState, 0), isNull(aiMemory.validTo), eq(aiMemory.content, content)))
    .limit(1)
  return row
}

// 新增一条记忆
export async function insertMemoryRow(content: string, kind: string, confidence: number, sourceEventId: number | null): Promise<void> {
  const { db } = getDatabase()
  await db.insert(aiMemory).values({ content, kind, confidence, sourceEventId })
}

// 改可信度；低到一定程度就标失效（旧的只标失效、不删）
export async function updateMemoryConfidence(id: number, confidence: number, invalidate: boolean): Promise<void> {
  const { db } = getDatabase()
  await db
    .update(aiMemory)
    .set({ confidence, ...(invalidate ? { validTo: new Date() } : {}) })
    .where(eq(aiMemory.id, id))
}

// 按 id 取几条记忆
export async function findMemoriesByIds(ids: number[]): Promise<AiMemoryEntity[]> {
  if (ids.length === 0) {
    return []
  }
  const { db } = getDatabase()
  return db.select().from(aiMemory).where(inArray(aiMemory.id, ids))
}

// 记忆最近一次变化的时间（新增、改可信度、失效都算）
export async function lastMemoryChange(): Promise<Date | null> {
  const { db } = getDatabase()
  const [row] = await db.select({ t: sql<Date | null>`max(${aiMemory.updateTime})` }).from(aiMemory)
  return row?.t ? new Date(row.t) : null
}

// 某条之后的事件（不含 R-18 的），按先后
export async function findEventsAfter(lastId: number, limit: number): Promise<AiEventEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(aiEvent)
    .where(and(gt(aiEvent.id, lastId), eq(aiEvent.deleteState, 0), eq(aiEvent.isR18, false)))
    .orderBy(asc(aiEvent.id))
    .limit(limit)
}

// 最近的某几类事件（不含 R-18 的），统计习惯用；从新到旧最多 limit 条
export async function findRecentEvents(kinds: string[], limit: number): Promise<AiEventEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(aiEvent)
    .where(and(inArray(aiEvent.kind, kinds), eq(aiEvent.deleteState, 0), eq(aiEvent.isR18, false)))
    .orderBy(desc(aiEvent.id))
    .limit(limit)
}

// 做梦的进度：一条 kind = DREAM 的任务，payload 里记整理到哪一条事件
export async function findDreamCursor(): Promise<{ jobId: number; lastEventId: number } | null> {
  const { db } = getDatabase()
  const [row] = await db
    .select()
    .from(aiJob)
    .where(and(eq(aiJob.kind, 'DREAM'), eq(aiJob.deleteState, 0)))
    .orderBy(desc(aiJob.id))
    .limit(1)
  if (!row) {
    return null
  }
  const p = (row.payload ?? {}) as { lastEventId?: number }
  return { jobId: row.id, lastEventId: Number(p.lastEventId ?? 0) }
}

// 保存做梦的进度
export async function saveDreamCursor(jobId: number | null, lastEventId: number): Promise<number> {
  const { db } = getDatabase()
  if (jobId === null) {
    const [row] = await db.insert(aiJob).values({ kind: 'DREAM', status: 'DONE', payload: { lastEventId }, finishedAt: new Date() }).returning({ id: aiJob.id })
    return row.id
  }
  await db.update(aiJob).set({ payload: { lastEventId }, finishedAt: new Date() }).where(eq(aiJob.id, jobId))
  return jobId
}
