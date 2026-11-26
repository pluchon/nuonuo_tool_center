import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import { BizError } from '../common/bizError'
import { getDatabase } from '../db/client'
import { col } from '../db/sqlUtil'
import { aiCompaction, aiConversation, aiImageExclusion, aiImageOriginal, aiMemory, aiMessage, categoryProposal } from '../db/schema'
import { invalidateProfileCache } from './aiPolicyRepository'

export type AiConversationEntity = typeof aiConversation.$inferSelect
export type AiMessageEntity = typeof aiMessage.$inferSelect
export type AiCompactionEntity = typeof aiCompaction.$inferSelect

export interface ConversationDraft {
  messageId: number
  content: unknown
}

function parseDraft(raw: unknown): ConversationDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as { messageId?: unknown; content?: unknown }
  if (typeof candidate.messageId !== 'number' || !Number.isSafeInteger(candidate.messageId) || candidate.messageId <= 0) {
    return null
  }
  if (!('content' in candidate)) return null
  return { messageId: candidate.messageId, content: candidate.content }
}

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
export async function insertMessage(conversationId: number, role: AiMessageEntity['role'], content: unknown,
  original?: { hash: string; bytes: Buffer }): Promise<AiMessageEntity> {
  const { db } = getDatabase()
  if (role === 'USER') {
    return db.transaction(async (tx) => {
      if (original) await tx.insert(aiImageOriginal).values(original).onConflictDoNothing()
      await tx.update(aiConversation).set({ draft: null }).where(eq(aiConversation.id, conversationId))
      const [row] = await tx.insert(aiMessage).values({ conversationId, role, content }).returning()
      return row
    })
  }
  const [row] = await db.insert(aiMessage).values({ conversationId, role, content }).returning()
  return row
}

// 原图只按仍可查看的消息读取，包含撤回到输入框的草稿。
export async function attachmentOriginal(messageId: number): Promise<string | null> {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new BizError('BAD_REQUEST', '无效的消息编号')
  const { rows } = await getDatabase().pg.query<{ bytes: Uint8Array; mime: string }>(
    `select o.bytes, a->>'mimeType' as mime
     from (
       select m.content->'attachments' as attachments
       from ai_message m
       join ai_conversation c on c.id = m.conversation_id and c.delete_state = 0
       where m.id = $1 and m.role = 'USER' and m.delete_state = 0
         and jsonb_typeof(m.content->'attachments') = 'array'
       union all
       select c.draft->'content'->'attachments' as attachments
       from ai_conversation c
       where c.delete_state = 0
         and (c.draft->>'messageId')::bigint = $1
         and jsonb_typeof(c.draft->'content'->'attachments') = 'array'
     ) src
     cross join lateral jsonb_array_elements(src.attachments) a
     join ai_image_original o on o.hash = a->>'originalHash'
     where a->>'kind' = 'image'
     limit 1`,
    [messageId]
  )
  return rows[0] ? `data:${rows[0].mime};base64,${Buffer.from(rows[0].bytes).toString('base64')}` : null
}

// 撤回到输入框的草稿存在 ai_conversation.draft 中，直到下一次发送或覆盖编辑。
export async function findRecalledMessage(conversationId: number): Promise<AiMessageEntity | undefined> {
  const [row] = await getDatabase().db
    .select({
      draft: aiConversation.draft,
      createTime: aiConversation.createTime,
      updateTime: aiConversation.updateTime
    })
    .from(aiConversation)
    .where(and(eq(aiConversation.id, conversationId), eq(aiConversation.deleteState, 0)))
    .limit(1)
  if (!row) return undefined
  const draft = parseDraft(row.draft)
  if (!draft) return undefined
  return {
    id: draft.messageId,
    conversationId,
    role: 'USER',
    content: draft.content,
    vote: null,
    createTime: row.createTime,
    updateTime: row.updateTime,
    deleteState: 1
  } as AiMessageEntity
}

export async function reviseLastUserMessage(
  conversationId: number, messageId: number, replace?: (row: AiMessageEntity) => unknown
): Promise<AiMessageEntity> {
  return getDatabase().db.transaction(async (tx) => {
    const [last] = await tx.select().from(aiMessage).where(and(
      eq(aiMessage.conversationId, conversationId), eq(aiMessage.role, 'USER'), eq(aiMessage.deleteState, 0)
    )).orderBy(desc(aiMessage.id)).limit(1)
    if (last?.id !== messageId) throw new BizError('CONFLICT', '只能修改最后一条用户消息')
    const replacement = replace?.(last)

    const toDelete = await tx
      .select({ id: aiMessage.id, role: aiMessage.role, content: aiMessage.content })
      .from(aiMessage)
      .where(and(eq(aiMessage.conversationId, conversationId), gte(aiMessage.id, messageId), eq(aiMessage.deleteState, 0)))

    const deletedMessageIds = toDelete.map((row) => row.id)
    const proposalIds: number[] = []
    for (const row of toDelete) {
      if (row.role === 'ASSISTANT' && row.content && typeof row.content === 'object') {
        const pid = (row.content as { categoryProposalId?: unknown }).categoryProposalId
        if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
          proposalIds.push(pid)
        }
      }
    }

    if (deletedMessageIds.length > 0) {
      await tx.update(aiMessage).set({ deleteState: 1 }).where(inArray(aiMessage.id, deletedMessageIds))
    }

    const now = new Date()
    const invalidated = deletedMessageIds.length > 0
      ? await tx
        .update(aiMemory)
        .set({ validTo: now, updateTime: now })
        .where(and(inArray(aiMemory.sourceMessageId, deletedMessageIds), isNull(aiMemory.validTo)))
        .returning({ id: aiMemory.id })
      : []

    const resurrected = deletedMessageIds.length > 0
      ? await tx
        .update(aiMemory)
        .set({ validTo: null, supersededByMessageId: null, updateTime: now })
        .where(and(
          inArray(aiMemory.supersededByMessageId, deletedMessageIds),
          eq(aiMemory.deleteState, 0),
          or(isNull(aiMemory.sourceMessageId), notInArray(aiMemory.sourceMessageId, deletedMessageIds))
        ))
        .returning({ id: aiMemory.id })
      : []

    if (invalidated.length > 0 || resurrected.length > 0) {
      await invalidateProfileCache(tx)
    }

    if (deletedMessageIds.length > 0) {
      await tx.delete(aiImageExclusion).where(inArray(aiImageExclusion.sourceMessageId, deletedMessageIds))
    }

    if (proposalIds.length > 0) {
      await tx
        .update(categoryProposal)
        .set({ status: 'cancelled' })
        .where(and(inArray(categoryProposal.id, proposalIds), eq(categoryProposal.status, 'pending')))
    }

    await tx.update(aiCompaction).set({ deleteState: 1 }).where(and(
      eq(aiCompaction.conversationId, conversationId), gte(aiCompaction.upToMessageId, messageId), eq(aiCompaction.deleteState, 0)
    ))

    if (replace) {
      await tx.update(aiConversation).set({ draft: null }).where(eq(aiConversation.id, conversationId))
      const [row] = await tx.insert(aiMessage).values({ conversationId, role: 'USER', content: replacement }).returning()
      return row
    }
    await tx.update(aiConversation).set({ draft: { messageId: last.id, content: last.content } }).where(eq(aiConversation.id, conversationId))
    return last
  })
}

export async function saveCompactionForMessage(upToMessageId: number, summary: string, tokenBound = 0): Promise<boolean> {
  return getDatabase().db.transaction(async (tx) => {
    const [msg] = await tx
      .select({ conversationId: aiMessage.conversationId })
      .from(aiMessage)
      .where(and(eq(aiMessage.id, upToMessageId), eq(aiMessage.role, 'ASSISTANT'), eq(aiMessage.deleteState, 0)))
      .limit(1)
    if (!msg) return false
    await tx
      .update(aiCompaction)
      .set({ deleteState: 1 })
      .where(and(
        eq(aiCompaction.conversationId, msg.conversationId),
        eq(aiCompaction.upToMessageId, upToMessageId),
        eq(aiCompaction.deleteState, 0)
      ))
    await tx.insert(aiCompaction).values({
      conversationId: msg.conversationId,
      upToMessageId,
      summary,
      tokenBound: Math.max(0, Math.round(tokenBound))
    })
    return true
  })
}

export async function findCompactionsByConversation(conversationId: number): Promise<AiCompactionEntity[]> {
  return getDatabase().db
    .select()
    .from(aiCompaction)
    .where(and(eq(aiCompaction.conversationId, conversationId), eq(aiCompaction.deleteState, 0)))
    .orderBy(asc(aiCompaction.upToMessageId), asc(aiCompaction.id))
}

export async function findLatestCompaction(conversationId: number): Promise<AiCompactionEntity | undefined> {
  const [row] = await getDatabase().db
    .select()
    .from(aiCompaction)
    .where(and(eq(aiCompaction.conversationId, conversationId), eq(aiCompaction.deleteState, 0)))
    .orderBy(desc(aiCompaction.upToMessageId), desc(aiCompaction.id))
    .limit(1)
  return row
}

export async function findCompactionMap(messageIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (messageIds.length === 0) return out
  const rows = await getDatabase().db
    .select({ upToMessageId: aiCompaction.upToMessageId, summary: aiCompaction.summary })
    .from(aiCompaction)
    .where(and(inArray(aiCompaction.upToMessageId, messageIds), eq(aiCompaction.deleteState, 0)))
    .orderBy(asc(aiCompaction.id))
  for (const row of rows) {
    out.set(row.upToMessageId, row.summary)
  }
  return out
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

// 给一条回复点赞、踩或取消；只对诺诺的回复有效，返回改后的这条（不存在时为空）
export async function updateVote(messageId: number, vote: 'UP' | 'DOWN' | null): Promise<AiMessageEntity | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .update(aiMessage)
    .set({ vote })
    .where(and(eq(aiMessage.id, messageId), eq(aiMessage.role, 'ASSISTANT'), eq(aiMessage.deleteState, 0)))
    .returning()
  return row
}

export interface UpsertMemoryParams {
  content: string
  kind?: string
  confidence?: number
  sourceMessageId: number | null
  replaceId?: number
}

export interface UpsertMemoryResult {
  action: 'saved' | 'updated'
  memoryId: number
  previousContent?: string
}

// 写入或更新一条对话记忆；传入 replaceId 时在事务内失效旧记录并记录 supersededByMessageId（支持撤回恢复）
export async function upsertMemoryByMessage(params: UpsertMemoryParams): Promise<UpsertMemoryResult> {
  const content = params.content.trim()
  if (!content) {
    throw new BizError('BAD_REQUEST', '记忆内容不能为空')
  }
  const kind = params.kind ?? 'preference'
  const confidence = params.confidence ?? 0.9
  const sourceMessageId = params.sourceMessageId ?? null
  const replaceId = params.replaceId

  return getDatabase().db.transaction(async (tx) => {
    if (typeof replaceId === 'number' && Number.isSafeInteger(replaceId) && replaceId > 0) {
      const [existing] = await tx
        .select({
          id: aiMemory.id,
          content: aiMemory.content,
          confidence: aiMemory.confidence
        })
        .from(aiMemory)
        .where(and(eq(aiMemory.id, replaceId), eq(aiMemory.deleteState, 0), isNull(aiMemory.validTo)))
        .limit(1)

      if (existing) {
        if (existing.content.trim() === content) {
          if (existing.confidence < confidence) {
            await tx
              .update(aiMemory)
              .set({ confidence, updateTime: new Date() })
              .where(eq(aiMemory.id, existing.id))
          }
          return { action: 'updated', memoryId: existing.id, previousContent: existing.content }
        }
        const now = new Date()
        await tx
          .update(aiMemory)
          .set({ validTo: now, supersededByMessageId: sourceMessageId, updateTime: now })
          .where(eq(aiMemory.id, existing.id))
        const [inserted] = await tx
          .insert(aiMemory)
          .values({ content, kind, confidence, sourceMessageId })
          .returning({ id: aiMemory.id })
        await invalidateProfileCache(tx)
        return { action: 'updated', memoryId: inserted.id, previousContent: existing.content }
      }
    }

    const [known] = await tx
      .select({ id: aiMemory.id, confidence: aiMemory.confidence })
      .from(aiMemory)
      .where(and(
        eq(aiMemory.content, content),
        eq(aiMemory.kind, kind),
        eq(aiMemory.deleteState, 0),
        isNull(aiMemory.validTo)
      ))
      .limit(1)

    if (known) {
      if (known.confidence < confidence) {
        await tx
          .update(aiMemory)
          .set({ confidence, updateTime: new Date() })
          .where(eq(aiMemory.id, known.id))
      }
      return { action: 'saved', memoryId: known.id }
    }

    const [inserted] = await tx
      .insert(aiMemory)
      .values({ content, kind, confidence, sourceMessageId })
      .returning({ id: aiMemory.id })
    return { action: 'saved', memoryId: inserted.id }
  })
}

// 遗忘一条记忆：仅置 validTo 与 supersededByMessageId（不物理删，撤回消息时可恢复）并使档案/做梦摘要失效
export async function forgetMemoryByMessage(params: {
  id: number
  messageId: number | null
}): Promise<{ deleted: boolean; content?: string }> {
  if (!Number.isSafeInteger(params.id) || params.id <= 0) {
    return { deleted: false }
  }
  return getDatabase().db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: aiMemory.id, content: aiMemory.content })
      .from(aiMemory)
      .where(and(eq(aiMemory.id, params.id), eq(aiMemory.deleteState, 0), isNull(aiMemory.validTo)))
      .limit(1)
    if (!existing) {
      return { deleted: false }
    }
    const now = new Date()
    await tx
      .update(aiMemory)
      .set({ validTo: now, supersededByMessageId: params.messageId ?? null, updateTime: now })
      .where(eq(aiMemory.id, existing.id))
    await invalidateProfileCache(tx)
    return { deleted: true, content: existing.content }
  })
}

// 记下一条对话里明说的偏好（向后兼容旧签名）
export async function insertMemory(content: string, kind: string, confidence: number, sourceMessageId: number | null): Promise<void> {
  await upsertMemoryByMessage({ content, kind, confidence, sourceMessageId })
}
