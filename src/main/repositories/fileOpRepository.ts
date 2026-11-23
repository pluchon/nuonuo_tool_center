import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { relative } from 'node:path'
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
  // 整个文件夹的操作（改名、删除类目录）没有对应的文件记录
  imageFileId: number | null
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

// 定下实际的目标路径（重名加编号后）
export async function updateOpToPath(dbx: Db, id: number, toPath: string): Promise<void> {
  await dbx.update(fileOp).set({ toPath }).where(eq(fileOp.id, id))
}

// 批次里做完的步骤（撤销用）
export async function findDoneOps(batchId: number): Promise<FileOpEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(fileOp)
    .where(and(eq(fileOp.batchId, batchId), eq(fileOp.status, 'DONE'), eq(fileOp.deleteState, 0)))
    .orderBy(asc(fileOp.seq))
}

// 某个位置上还挂着的旧记录（文件早就不在了）逻辑删除，给新文件腾出位置
export async function retireRowsAt(dbx: Db, rootId: number, relPath: string): Promise<void> {
  await dbx
    .update(imageFile)
    .set({ deleteState: 1 })
    .where(and(eq(imageFile.rootId, rootId), sql`lower(${imageFile.relPath}) = ${relPath.toLowerCase()}`, eq(imageFile.deleteState, 0)))
}

// 文件挪了位置：记录跟着改（移出图库后撤销挪回来时，记录重新算在图库里）
export async function relocateImageFile(dbx: Db, id: number, rootId: number, relPath: string): Promise<void> {
  await dbx.update(imageFile).set({ rootId, relPath, status: 'NORMAL', deleteState: 0 }).where(eq(imageFile.id, id))
}

// 正常移动和崩溃恢复按同一规则更新位置。移动到图库外时只移除文件记录。
export async function recordMovedFile(dbx: Db, id: number, root: { id: number; path: string } | null, path: string): Promise<void> {
  if (!root) return retireImageFile(dbx, id)
  const rel = relative(root.path, path)
  await retireRowsAt(dbx, root.id, rel)
  await relocateImageFile(dbx, id, root.id, rel)
}

// 复制出来的新文件：同一张图多一个位置
export async function insertCopiedFile(dbx: Db, row: { imageId: number; rootId: number; relPath: string; mtime: Date }): Promise<number> {
  const [created] = await dbx
    .insert(imageFile)
    .values({ ...row, status: 'NORMAL' })
    .returning({ id: imageFile.id })
  return created.id
}

// 图库内的副本关联到同一张图片，导出到图库外不增加位置。
export async function recordCopiedFile(dbx: Db, imageId: number, root: { id: number; path: string } | null, path: string, mtime: Date): Promise<void> {
  if (!root) return
  const rel = relative(root.path, path)
  await retireRowsAt(dbx, root.id, rel)
  await insertCopiedFile(dbx, { imageId, rootId: root.id, relPath: rel, mtime })
}

// 某张图在某个目录下已有的位置（相对路径，不含子目录）：复制时“已有副本”
export async function findImagesInDir(dbx: Db, imageIds: number[], rootId: number, relDir: string): Promise<Set<number>> {
  if (imageIds.length === 0) {
    return new Set()
  }
  const dirExpr = sql`lower(regexp_replace(${imageFile.relPath}, '\\\\?[^\\\\]*$', ''))`
  const rows = await dbx
    .select({ imageId: imageFile.imageId })
    .from(imageFile)
    .where(
      and(
        inArray(imageFile.imageId, imageIds),
        eq(imageFile.rootId, rootId),
        eq(imageFile.deleteState, 0),
        eq(imageFile.status, 'NORMAL'),
        sql`${dirExpr} = ${relDir.toLowerCase()}`
      )
    )
  return new Set(rows.map((r) => r.imageId))
}

// 某个文件夹下（含子目录）文件的条件：相对路径以 “prefix\” 开头（不区分大小写）
function underPrefix(rootId: number, prefix: string) {
  const normalized = prefix.replaceAll('\\', '/').toLowerCase() + '/'
  return and(eq(imageFile.rootId, rootId), eq(imageFile.deleteState, 0),
    sql`starts_with(lower(replace(${imageFile.relPath}, chr(92), '/')), ${normalized})`)
}

// 文件夹改名：下面所有文件记录的相对路径前缀跟着换
export async function renameRowsUnder(dbx: Db, rootId: number, oldPrefix: string, newPrefix: string): Promise<void> {
  await dbx
    .update(imageFile)
    .set({ relPath: sql`${newPrefix} || replace(substr(${imageFile.relPath}, char_length(${oldPrefix}::text) + 1), '/', chr(92))` })
    .where(underPrefix(rootId, oldPrefix))
  // 目录结构和待确认的归档目标在同一事务中迁移，避免继续采用时新建旧目录。
  await syncOrganizeTarget(dbx, oldPrefix, newPrefix, true)
}

// 首次采用会将候选目录固定为已存在的路径。迁移或删除整个子树时，子目录也同步失去自动新建资格。
export async function syncOrganizeTarget(dbx: Db, oldPrefix: string, newPrefix: string, subtree = false): Promise<void> {
  const oldNorm = oldPrefix.replaceAll('\\', '/').toLowerCase()
  await dbx.execute(sql`update image_ai_result
    set result = jsonb_set(jsonb_set(result, '{existing}', 'true'), '{dir}', to_jsonb(${newPrefix}::text || replace(substr(result->>'dir', char_length(${oldPrefix}::text) + 1), '/', chr(92))))
    where delete_state = 0 and kind = 'ORGANIZE' and field_status->>'dir' = 'PENDING'
      and (lower(replace(result->>'dir', chr(92), '/')) = ${oldNorm}
        or (${subtree} and starts_with(lower(replace(result->>'dir', chr(92), '/')), ${oldNorm + '/'})))`)
  await dbx.execute(sql`update app_setting s set value=(
    select coalesce(jsonb_agg(case when lower(replace(f->>'name',chr(92),'/'))=${oldNorm}
      or (${subtree} and starts_with(lower(replace(f->>'name',chr(92),'/')),${oldNorm + '/'}))
      then jsonb_set(jsonb_set(f,'{isNew}','false'),'{name}',to_jsonb(${newPrefix}::text || replace(substr(f->>'name',char_length(${oldPrefix}::text)+1),'/',chr(92))))
      else f end order by n),'[]'::jsonb) from jsonb_array_elements(s.value) with ordinality a(f,n))
    where s.key='ai.organize.rules' and s.delete_state=0`)
}

export async function observeOrganizeTarget(path: string, actual = path): Promise<void> {
  await getDatabase().db.transaction((tx) => syncOrganizeTarget(tx, path, actual))
}

// 整个文件夹要进回收站：下面的文件记录先藏起来，返回它们的 id
export async function hideRowsUnder(dbx: Db, rootId: number, prefix: string): Promise<number[]> {
  const rows = await dbx
    .update(imageFile)
    .set({ status: 'DELETED' })
    .where(underPrefix(rootId, prefix))
    .returning({ id: imageFile.id, imageId: imageFile.imageId })
  return rows.map((r) => r.id)
}

// 文件夹已进回收站：下面藏起来的记录逻辑删除
export async function retireRowsUnder(dbx: Db, rootId: number, prefix: string): Promise<void> {
  await syncOrganizeTarget(dbx, prefix, prefix, true)
  await dbx
    .update(imageFile)
    .set({ deleteState: 1 })
    .where(and(underPrefix(rootId, prefix), eq(imageFile.status, 'DELETED')))
}

// 文件夹没删掉：藏起来的记录恢复正常
export async function unhideRowsUnder(dbx: Db, rootId: number, prefix: string): Promise<void> {
  await dbx
    .update(imageFile)
    .set({ status: 'NORMAL' })
    .where(and(underPrefix(rootId, prefix), eq(imageFile.status, 'DELETED')))
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
