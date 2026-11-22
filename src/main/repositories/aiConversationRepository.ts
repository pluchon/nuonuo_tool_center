import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { col } from '../db/sqlUtil'
import { aiConversation, aiMemory, aiMessage } from '../db/schema'

export type AiConversationEntity = typeof aiConversation.$inferSelect
export type AiMessageEntity = typeof aiMessage.$inferSelect

// 对话最后一次说话的时间（没有消息时用创建时间）；改名、置顶不算
const lastAt = sql<Date>`coalesce((select max(${col(aiMessage.createTime)}) from ${aiMessage} where ${col(aiMessage.conversationId)} = ${col(aiConversation.id)} and ${col(aiMessage.deleteState)} = 0), ${col(aiConversation.createTime)})`

// 新开一段对话
export async function insertConversation(title: string, profileVersion: number | null): Promise<AiConversationEntity> {
  const { db } = getDatabase()
  const [row] = await db.insert(aiConversation).values({ title, profileVersion }).returning()
  return row
}

// 全部对话：置顶的在前，其余按最后说话的时间从新到旧
export async function findConversations(): Promise<Array<AiConversationEntity & { lastAt: Date }>> {
  const { db } = getDatabase()
  const rows = await db
    .select({ c: aiConversation, lastAt })
    .from(aiConversation)
    .where(eq(aiConversation.deleteState, 0))
    .orderBy(desc(aiConversation.pinned), desc(lastAt), desc(aiConversation.id))
  return rows.map((r) => ({ ...r.c, lastAt: new Date(r.lastAt) }))
}

// 按 id 取一段对话；includeDeleted 为真时也取已删的（撤销删除用）
export async function findConversation(id: number, includeDeleted = false): Promise<(AiConversationEntity & { lastAt: Date }) | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .select({ c: aiConversation, lastAt })
    .from(aiConversation)
    .where(includeDeleted ? eq(aiConversation.id, id) : and(eq(aiConversation.id, id), eq(aiConversation.deleteState, 0)))
    .limit(1)
  return row ? { ...row.c, lastAt: new Date(row.lastAt) } : undefined
}

// 改对话的名字、置顶或删除状态
export async function updateConversation(id: number, patch: Partial<Pick<AiConversationEntity, 'title' | 'pinned' | 'deleteState'>>): Promise<number> {
  const { db } = getDatabase()
  const rows = await db.update(aiConversation).set(patch).where(eq(aiConversation.id, id)).returning({ id: aiConversation.id })
  return rows.length
}

// 存一条消息
export async function insertMessage(conversationId: number, role: AiMessageEntity['role'], content: unknown): Promise<AiMessageEntity> {
  const { db } = getDatabase()
  const [row] = await db.insert(aiMessage).values({ conversationId, role, content }).returning()
  return row
}

// 一段对话的全部消息，按先后
export async function findMessages(conversationId: number): Promise<AiMessageEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(aiMessage)
    .where(and(eq(aiMessage.conversationId, conversationId), eq(aiMessage.deleteState, 0)))
    .orderBy(asc(aiMessage.id))
}

// 给一条回复点赞、踩或取消；只对诺诺的回复有效
export async function updateVote(messageId: number, vote: 'UP' | 'DOWN' | null): Promise<number> {
  const { db } = getDatabase()
  const rows = await db
    .update(aiMessage)
    .set({ vote })
    .where(and(eq(aiMessage.id, messageId), eq(aiMessage.role, 'ASSISTANT'), eq(aiMessage.deleteState, 0)))
    .returning({ id: aiMessage.id })
  return rows.length
}

// 记下一条对话里明说的偏好
export async function insertMemory(content: string, kind: string, confidence: number, sourceMessageId: number | null): Promise<void> {
  const { db } = getDatabase()
  await db.insert(aiMemory).values({ content, kind, confidence, sourceMessageId })
}
