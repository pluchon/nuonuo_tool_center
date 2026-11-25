import { and, eq, sql } from 'drizzle-orm'
import { BizError } from '../common/bizError'
import { getDatabase, type AppDatabase } from '../db/client'
import { aiWorkflow } from '../db/schema'

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
export type WorkflowDb = AppDatabase | Tx

export interface WorkflowRow<T = unknown> {
  id: number
  kind: string
  key: string
  status: string
  phase: string
  state: T
  version: number
  error: string | null
}

export interface WorkflowNext<T = unknown> {
  status: string
  phase: string
  state: T
  error?: string | null
}

function toWorkflowRow<T>(row: typeof aiWorkflow.$inferSelect): WorkflowRow<T> {
  return {
    id: Number(row.id),
    kind: row.kind,
    key: row.key,
    status: row.status,
    phase: row.phase,
    state: row.state as T,
    version: row.version,
    error: row.error
  }
}

export async function getWorkflow<T = Record<string, unknown>>(
  kind: string,
  key = 'default',
  dbx?: WorkflowDb
): Promise<WorkflowRow<T> | null> {
  const db = dbx ?? getDatabase().db
  const [row] = await db
    .select()
    .from(aiWorkflow)
    .where(and(eq(aiWorkflow.kind, kind), eq(aiWorkflow.key, key), eq(aiWorkflow.deleteState, 0)))
    .limit(1)
  return row ? toWorkflowRow<T>(row) : null
}

export async function upsertWorkflow<T = Record<string, unknown>>(
  kind: string,
  key = 'default',
  next: WorkflowNext<T>,
  expectedVersion?: number,
  dbx?: WorkflowDb
): Promise<WorkflowRow<T>> {
  const db = dbx ?? getDatabase().db
  const error = next.error ?? null
  if (expectedVersion !== undefined) {
    const [updated] = await db
      .update(aiWorkflow)
      .set({
        status: next.status,
        phase: next.phase,
        state: next.state,
        error,
        version: sql`${aiWorkflow.version} + 1`,
        updateTime: new Date()
      })
      .where(
        and(
          eq(aiWorkflow.kind, kind),
          eq(aiWorkflow.key, key),
          eq(aiWorkflow.version, expectedVersion),
          eq(aiWorkflow.deleteState, 0)
        )
      )
      .returning()
    if (!updated) {
      throw new BizError('CONFLICT', '后台流程状态已变化，请重试')
    }
    return toWorkflowRow<T>(updated)
  }

  const [saved] = await db
    .insert(aiWorkflow)
    .values({
      kind,
      key,
      status: next.status,
      phase: next.phase,
      state: next.state,
      error
    })
    .onConflictDoUpdate({
      target: [aiWorkflow.kind, aiWorkflow.key],
      targetWhere: sql`${aiWorkflow.deleteState} = 0`,
      set: {
        status: next.status,
        phase: next.phase,
        state: next.state,
        error,
        version: sql`${aiWorkflow.version} + 1`,
        updateTime: new Date()
      }
    })
    .returning()
  return toWorkflowRow<T>(saved)
}

export async function transitionWorkflow<T = Record<string, unknown>>(
  kind: string,
  key = 'default',
  fn: (current: WorkflowRow<T> | null, tx: Tx) => Promise<WorkflowNext<T> | null | void> | WorkflowNext<T> | null | void
): Promise<WorkflowRow<T> | null> {
  return getDatabase().db.transaction(async (tx) => {
    const current = await getWorkflow<T>(kind, key, tx)
    const next = await fn(current, tx)
    if (!next) {
      return current
    }
    if (current) {
      return upsertWorkflow<T>(kind, key, next, current.version, tx)
    }
    const [created] = await tx
      .insert(aiWorkflow)
      .values({
        kind,
        key,
        status: next.status,
        phase: next.phase,
        state: next.state,
        error: next.error ?? null
      })
      .onConflictDoNothing()
      .returning()
    if (!created) {
      throw new BizError('CONFLICT', '后台流程状态已变化，请重试')
    }
    return toWorkflowRow<T>(created)
  })
}

export const PgWorkflow = {
  get: getWorkflow,
  upsert: upsertWorkflow,
  transition: transitionWorkflow
}
