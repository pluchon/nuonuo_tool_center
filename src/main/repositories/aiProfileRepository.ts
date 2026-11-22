import { and, desc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { aiProfile } from '../db/schema'

export type AiProfileEntity = typeof aiProfile.$inferSelect

// 最新一版核心档案
export async function findLatestProfile(): Promise<AiProfileEntity | undefined> {
  const { db } = getDatabase()
  const [row] = await db.select().from(aiProfile).where(eq(aiProfile.deleteState, 0)).orderBy(desc(aiProfile.version)).limit(1)
  return row
}

// 指定版本的核心档案（对话锁定的那一版）
export async function findProfileByVersion(version: number): Promise<AiProfileEntity | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .select()
    .from(aiProfile)
    .where(and(eq(aiProfile.version, version), eq(aiProfile.deleteState, 0)))
    .limit(1)
  return row
}

// 新增一版核心档案
export async function insertProfile(version: number, content: string, tagVocab: unknown): Promise<AiProfileEntity> {
  const { db } = getDatabase()
  const [row] = await db.insert(aiProfile).values({ version, content, tagVocab }).returning()
  return row
}
