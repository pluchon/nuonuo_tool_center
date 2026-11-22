import { desc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { apiUsage } from '../db/schema'

export type ApiUsageInsert = typeof apiUsage.$inferInsert
export type ApiUsageEntity = typeof apiUsage.$inferSelect

// 记一次云端调用
export async function insertApiUsage(row: ApiUsageInsert): Promise<void> {
  const { db } = getDatabase()
  await db.insert(apiUsage).values(row)
}

// 某类调用最近的成功记录，按时间倒序，用于算命中率
export async function findRecentUsage(api: string, limit: number): Promise<ApiUsageEntity[]> {
  const { db } = getDatabase()
  const rows = await db.select().from(apiUsage).where(eq(apiUsage.api, api)).orderBy(desc(apiUsage.id)).limit(limit)
  return rows.filter((r) => !r.error)
}
