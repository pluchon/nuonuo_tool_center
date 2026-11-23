import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { apiUsage } from '../db/schema'

export type ApiUsageInsert = typeof apiUsage.$inferInsert
export type ApiUsageEntity = typeof apiUsage.$inferSelect

// 记一次云端调用
export async function insertApiUsage(row: ApiUsageInsert): Promise<void> {
  const { db } = getDatabase()
  await db.insert(apiUsage).values(row)
}

// 查询近期成功的实时推理。百炼批量推理不支持上下文缓存。
export async function findRecentUsage(api: string, limit: number): Promise<ApiUsageEntity[]> {
  const { db } = getDatabase()
  return db.select().from(apiUsage)
    .where(and(eq(apiUsage.api, api), eq(apiUsage.batch, false), isNull(apiUsage.error)))
    .orderBy(desc(apiUsage.id)).limit(limit)
}
