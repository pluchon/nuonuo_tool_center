import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AppDatabase } from '../db/client'
import { getDatabase } from '../db/client'
import { fileOp, fileOpBatch, imageFile } from '../db/schema'

export type FileOpBatchEntity = typeof fileOpBatch.$inferSelect
export type FileOpEntity = typeof fileOp.$inferSelect

// 事务里也能用的数据库句柄
type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
type Db = AppDatabase | Tx

// 一步要写进日志的文件操作
export interface PlannedOp {
  opType: FileOpEntity['opType']
  imageFileId: number
  fromPath: string
  toPath: string | null
  contentHash: string
}

// 新建一个批次和它的每一步（先写库，再动文件）
export async function insertBatch(dbx: Db, summary: string, ops: PlannedOp[]): Promise<number> {
  const [batch] = await dbx.insert(fileOpBatch).values({ origin: 'USER', summary, status: 'PLANNED' }).returning({ id: fileOpBatch.id })
  await dbx.insert(fileOp).values(ops.map((op, i) => ({ ...op, batchId: batch.id, seq: i + 1 })))
  return batch.id
}

// 按 id 查批次
export async function findBatch(id: number): Promise<FileOpBatchEntity | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .select()
    .from(fileOpBatch)
    .where(and(eq(fileOpBatch.id, id), eq(fileOpBatch.deleteState, 0)))
    .limit(1)
  return row
}

// 没做完的批次（计划了还没执行、执行到一半）：启动时对账用
export async function findUnfinishedBatches(): Promise<FileOpBatchEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(fileOpBatch)
    .where(and(inArray(fileOpBatch.status, ['PLANNED', 'APPLYING']), eq(fileOpBatch.deleteState, 0)))
    .orderBy(asc(fileOpBatch.id))
}

// 批次里还没做的步骤
export async function findPendingOps(batchId: number): Promise<FileOpEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(fileOp)
    .where(and(eq(fileOp.batchId, batchId), eq(fileOp.status, 'PENDING'), eq(fileOp.deleteState, 0)))
    .orderBy(asc(fileOp.seq))
}

// 改批次状态
export async function updateBatchStatus(dbx: Db, id: number, status: FileOpBatchEntity['status']): Promise<void> {
  await dbx.update(fileOpBatch).set({ status }).where(eq(fileOpBatch.id, id))
}

// 改一步的状态（失败时带上原因）
export async function updateOpStatus(dbx: Db, id: number, status: FileOpEntity['status'], error: string | null = null): Promise<void> {
  await dbx.update(fileOp).set({ status, error }).where(eq(fileOp.id, id))
}

// 批次里没做的步骤全部标成已撤销
export async function revertPendingOps(dbx: Db, batchId: number): Promise<void> {
  await dbx
    .update(fileOp)
    .set({ status: 'REVERTED' })
    .where(and(eq(fileOp.batchId, batchId), eq(fileOp.status, 'PENDING')))
}

// 文件记录先在库里藏起来（删除的撤销窗口内）
export async function hideImageFiles(dbx: Db, ids: number[]): Promise<void> {
  if (ids.length > 0) {
    await dbx.update(imageFile).set({ status: 'DELETED' }).where(inArray(imageFile.id, ids))
  }
}

// 撤销或删不掉时把文件记录恢复成某个状态
export async function restoreImageFiles(dbx: Db, ids: number[], status: 'NORMAL' | 'MISSING'): Promise<void> {
  if (ids.length > 0) {
    await dbx.update(imageFile).set({ status }).where(inArray(imageFile.id, ids))
  }
}

// 文件已经进了回收站：记录逻辑删除（释放“同一位置只有一条记录”的唯一约束，从回收站还原后扫描能重新登记）
export async function retireImageFile(dbx: Db, id: number): Promise<void> {
  await dbx.update(imageFile).set({ status: 'DELETED', deleteState: 1 }).where(eq(imageFile.id, id))
}

// 某个目录下正在等着进回收站的文件（相对路径）：扫描时跳过它们
export async function findHiddenRelPaths(rootId: number): Promise<string[]> {
  const { db } = getDatabase()
  const rows = await db
    .select({ relPath: imageFile.relPath })
    .from(imageFile)
    .where(and(eq(imageFile.rootId, rootId), eq(imageFile.status, 'DELETED'), eq(imageFile.deleteState, 0)))
  return rows.map((r) => r.relPath)
}
