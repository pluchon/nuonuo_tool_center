import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { BizError } from '../common/bizError'
import { getDatabase } from '../db/client'
import { categoryProposal } from '../db/schema'
import { upsertWorkflow } from './aiWorkflowRepository'
import { findPendingOps, insertBatch, renameRowsUnder, updateBatchStatus, updateOpStatus } from './fileOpRepository'

export type CategoryProposalRow = typeof categoryProposal.$inferSelect

export async function findProposalForMessage(id: number, messageId: number): Promise<CategoryProposalRow | undefined> {
  const [row] = await getDatabase().db.select().from(categoryProposal).where(and(
    eq(categoryProposal.id, id),
    sql`exists (select 1 from ai_message m join ai_conversation c on c.id = m.conversation_id
      where m.id = ${messageId} and m.delete_state = 0 and c.delete_state = 0 and m.role = 'ASSISTANT'
      and m.content->>'categoryProposalId' = ${String(id)})`
  ))
  return row
}

export async function findProposalSummaries(ids: number[]): Promise<Array<Pick<CategoryProposalRow, 'id' | 'status' | 'payload'>>> {
  if (!ids.length) return []
  return getDatabase().db
    .select({ id: categoryProposal.id, status: categoryProposal.status, payload: categoryProposal.payload })
    .from(categoryProposal)
    .where(inArray(categoryProposal.id, [...new Set(ids)]))
}

export async function findProposalById(id: number): Promise<CategoryProposalRow | undefined> {
  const [row] = await getDatabase().db.select().from(categoryProposal).where(eq(categoryProposal.id, id))
  return row
}

export async function insertCategoryProposal(
  home: string,
  payload: unknown,
  sourceMessageId?: number,
  analyzedImageIds: number[] = []
): Promise<number> {
  return getDatabase().db.transaction(async (tx) => {
    const [row] = await tx.insert(categoryProposal).values({ home, payload }).returning({ id: categoryProposal.id })
    if (analyzedImageIds.length) {
      await tx.execute(sql`insert into category_analyzed_image(image_id, proposal_id)
        select id, ${row.id} from unnest(${sql.param(analyzedImageIds)}::bigint[]) id`)
    }
    // 即使进程在助手回复入库之前退出，重试原消息也能找回这次提案。
    if (sourceMessageId) {
      await tx.execute(sql`update ai_message
        set content = jsonb_set(content, '{preparedProposalId}', to_jsonb(${row.id}::integer))
        where id = ${sourceMessageId} and role = 'USER' and delete_state = 0`)
    }
    return row.id
  })
}

export async function findPendingAnalysisProposal(home: string, scope: string | null): Promise<CategoryProposalRow | undefined> {
  const [previous] = await getDatabase().db.select().from(categoryProposal).where(and(
    eq(categoryProposal.status, 'pending'),
    eq(categoryProposal.home, home),
    sql`(payload->>'analysisCount')::int > 0 and (payload->>'scope') is not distinct from ${scope}::text`
  )).orderBy(desc(categoryProposal.id)).limit(1)
  return previous
}

export async function hasFilesUnderPath(rootId: number, relPath: string): Promise<boolean> {
  const normalized = relPath.replaceAll('\\', '/').toLowerCase() + '/'
  const occupied = await getDatabase().db.execute(sql`select 1 from image_file where root_id = ${rootId} and delete_state = 0
    and starts_with(lower(replace(rel_path, chr(92), '/')), ${normalized}) limit 1`)
  return occupied.rows.length > 0
}

export async function syncMovedCategoryRows(rootId: number, from: string, to: string): Promise<void> {
  await renameRowsUnder(getDatabase().db, rootId, from, to)
}

export async function beginMoveTreeBatch(fromAbs: string, toAbs: string, identity: string): Promise<{ batchId: number; opId: number }> {
  const batchId = await getDatabase().db.transaction(async (tx) => {
    const id = await insertBatch(tx, '迁移类目录', [{ opType: 'RENAME', imageFileId: null, fromPath: fromAbs, toPath: toAbs, contentHash: identity }])
    await updateBatchStatus(tx, id, 'APPLYING')
    return id
  })
  const [op] = await findPendingOps(batchId)
  return { batchId, opId: op.id }
}

export async function failMoveTreeBatch(batchId: number, opId: number, errorMessage: string): Promise<void> {
  await getDatabase().db.transaction(async (tx) => {
    await updateOpStatus(tx, opId, 'FAILED', errorMessage)
    await updateBatchStatus(tx, batchId, 'FAILED')
  })
}

export async function completeMoveTreeBatch(batchId: number, opId: number, rootId: number, from: string, to: string): Promise<void> {
  await getDatabase().db.transaction(async (tx) => {
    await renameRowsUnder(tx, rootId, from, to)
    await updateOpStatus(tx, opId, 'DONE')
    await updateBatchStatus(tx, batchId, 'APPLIED')
  })
}

export async function markProposalStarted(id: number): Promise<void> {
  await getDatabase().db.transaction(async (tx) => {
    const [updated] = await tx
      .update(categoryProposal)
      .set({ payload: sql`jsonb_set(${categoryProposal.payload}, '{started}', 'true'::jsonb)` })
      .where(and(
        eq(categoryProposal.id, id),
        eq(categoryProposal.status, 'pending'),
        sql`coalesce((${categoryProposal.payload}->>'started')::boolean, false) = false`
      ))
      .returning({ id: categoryProposal.id })

    if (!updated) {
      const [current] = await tx.select({ status: categoryProposal.status, payload: categoryProposal.payload })
        .from(categoryProposal).where(eq(categoryProposal.id, id)).limit(1)
      if (!current) throw new BizError('NOT_FOUND', '这条目录提案已经撤回')
      if (current.status !== 'pending') throw new BizError('CONFLICT', '目录提案状态已变化，请重试')
      const started = Boolean((current.payload as { started?: boolean } | null)?.started)
      if (!started) throw new BizError('CONFLICT', '目录提案状态已变化，请重试')
    }

    await upsertWorkflow(
      'CATEGORY_PROPOSAL',
      String(id),
      { status: 'RUNNING', phase: 'STARTED', state: { proposalId: id, started: true } },
      undefined,
      tx
    )
  })
}

export async function finishProposalDecision(id: number, nextStatus: 'applied' | 'cancelled'): Promise<CategoryProposalRow> {
  return getDatabase().db.transaction(async (tx) => {
    const [updated] = await tx
      .update(categoryProposal)
      .set({ status: nextStatus })
      .where(and(eq(categoryProposal.id, id), eq(categoryProposal.status, 'pending')))
      .returning()
    if (!updated) {
      throw new BizError('CONFLICT', '目录提案状态已变化，请重试')
    }
    await upsertWorkflow(
      'CATEGORY_PROPOSAL',
      String(id),
      {
        status: nextStatus === 'applied' ? 'DONE' : 'CANCELLED',
        phase: nextStatus.toUpperCase(),
        state: { proposalId: id, status: nextStatus }
      },
      undefined,
      tx
    )
    return updated
  })
}
