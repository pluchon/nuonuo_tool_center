import { stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeleteResultVO, FileOpDoneVO, GalleryQueryDTO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { getDatabase } from '../../db/client'
import {
  findBatch,
  findPendingOps,
  findUnfinishedBatches,
  hideImageFiles,
  insertBatch,
  restoreImageFiles,
  retireImageFile,
  revertPendingOps,
  updateBatchStatus,
  updateOpStatus,
  type FileOpEntity
} from '../../repositories/fileOpRepository'
import { filesForAction } from '../galleryService'

const log = getLogger('fileOps')

// 一次最多删多少张（和多选上限一致）
const MAX_BATCH = 200
// 删除先在库里藏起来，过这么久才真正进回收站（比提示条的 5 秒长一点，点“撤销”来得及）
export const TRASH_DELAY_MS = 6000

// 外部依赖：放进系统回收站（主进程里是 shell.trashItem；测试里换成假的）、批次做完的通知
interface FileOpsDeps {
  trash: (path: string) => Promise<void>
  onDone: (result: FileOpDoneVO) => void
}
let deps: FileOpsDeps = {
  trash: async () => {
    throw new Error('文件操作服务还没初始化')
  },
  onDone: () => undefined
}

// 放进回收站（撤销复制时删掉复制出来的文件也走这里）
export function trashPath(path: string): Promise<void> {
  return deps.trash(path)
}

// 启动时注入依赖
export function configureFileOps(next: Partial<FileOpsDeps>): void {
  deps = { ...deps, ...next }
}

// 所有动文件的操作串行执行：上一件做完再做下一件
let queue: Promise<unknown> = Promise.resolve()
export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

// 等着进回收站的批次和它们的定时器
const pending = new Map<number, ReturnType<typeof setTimeout>>()

// 文件在不在
async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => err.code !== 'ENOENT')
}

// 错误信息
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 删除：先写日志、在库里把这些位置藏起来，过一会儿再真正放进系统回收站（期间可以撤销）
// 在源目录、类目录里只删这个目录里的位置；其他视图删这张图的全部位置。目录找不到的位置不动
export async function deleteImages(query: GalleryQueryDTO, rawIds: unknown): Promise<DeleteResultVO> {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((v) => !Number.isInteger(v))) {
    throw new BizError('BAD_REQUEST', '没有选中图片')
  }
  const ids = [...new Set(rawIds as number[])]
  if (ids.length > MAX_BATCH) {
    throw new BizError('BAD_REQUEST', `一次最多删 ${MAX_BATCH} 张`)
  }
  const rows = await filesForAction(query, ids)
  const usable = rows.filter((r) => !r.offline)
  if (usable.length === 0) {
    throw new BizError(rows.length > 0 ? 'DEPENDENCY_FAILED' : 'NOT_FOUND', rows.length > 0 ? '源目录找不到，删不了' : '这些图已经不在图库里了')
  }
  const images = new Set(usable.map((r) => r.imageId)).size
  const { db } = getDatabase()
  const batchId = await db.transaction(async (tx) => {
    const id = await insertBatch(
      tx,
      `删除 ${images} 张`,
      usable.map((r) => ({
        opType: 'DELETE' as const,
        imageFileId: r.fileId,
        fromPath: join(r.rootPath, r.relPath),
        toPath: null,
        contentHash: r.contentHash
      }))
    )
    await hideImageFiles(
      tx,
      usable.map((r) => r.fileId)
    )
    return id
  })
  pending.set(
    batchId,
    setTimeout(() => {
      void commitDelete(batchId).catch((err: unknown) => log.error(`删除批次 ${batchId} 执行失败`, err))
    }, TRASH_DELAY_MS)
  )
  return { batchId, images, skipped: rows.length - usable.length }
}

// 撤销还没执行的删除：文件记录恢复（文件还在就是正常，不在就是找不到），日志标成已撤销
export async function undoDelete(batchId: unknown): Promise<void> {
  if (!Number.isInteger(batchId)) {
    throw new BizError('BAD_REQUEST', '操作 id 不对')
  }
  const id = batchId as number
  await enqueue(async () => {
    const batch = await findBatch(id)
    if (!batch || batch.status !== 'PLANNED') {
      throw new BizError('CONFLICT', '已经放进系统回收站了，可以到回收站里还原')
    }
    const timer = pending.get(id)
    if (timer) {
      clearTimeout(timer)
      pending.delete(id)
    }
    const ops = await findPendingOps(id)
    const present: number[] = []
    const gone: number[] = []
    for (const op of ops) {
      if (op.imageFileId !== null) {
        ;((await exists(op.fromPath)) ? present : gone).push(op.imageFileId)
      }
    }
    const { db } = getDatabase()
    await db.transaction(async (tx) => {
      await restoreImageFiles(tx, present, 'NORMAL')
      await restoreImageFiles(tx, gone, 'MISSING')
      await revertPendingOps(tx, id)
      await updateBatchStatus(tx, id, 'UNDONE')
    })
  })
}

// 执行一个删除批次：逐个放进系统回收站。删不掉的（被占用、没权限）恢复成正常并记下原因
function commitDelete(batchId: number): Promise<void> {
  const timer = pending.get(batchId)
  if (timer) {
    clearTimeout(timer)
    pending.delete(batchId)
  }
  return enqueue(() => applyBatch(batchId))
}

// 按日志把批次里没做的步骤做完（正常执行和崩溃后补做都走这里）
async function applyBatch(batchId: number): Promise<void> {
  const batch = await findBatch(batchId)
  if (!batch || (batch.status !== 'PLANNED' && batch.status !== 'APPLYING')) {
    return
  }
  const { db } = getDatabase()
  await updateBatchStatus(db, batchId, 'APPLYING')
  const ops = await findPendingOps(batchId)
  let done = 0
  let failed = 0
  let firstError: string | null = null
  for (const op of ops) {
    // 移动、复制是当场执行的，只有崩溃时才会留下没做完的步骤：按磁盘现状收尾
    const result = op.opType === 'DELETE' ? await applyDelete(op) : await settleTransferOp(op)
    if (result === null) {
      done += 1
    } else {
      failed += 1
      firstError ??= result
    }
  }
  await updateBatchStatus(db, batchId, failed > 0 && done === 0 ? 'FAILED' : 'APPLIED')
  deps.onDone({ batchId, done, failed, error: firstError })
}

// 删一个文件；成功返回 null，失败返回原因
async function applyDelete(op: FileOpEntity): Promise<string | null> {
  const { db } = getDatabase()
  try {
    if (await exists(op.fromPath)) {
      await deps.trash(op.fromPath)
    }
    await db.transaction(async (tx) => {
      await updateOpStatus(tx, op.id, 'DONE')
      if (op.imageFileId !== null) {
        await retireImageFile(tx, op.imageFileId)
      }
    })
    return null
  } catch (err) {
    const message = reason(err)
    log.warn(`放进回收站失败：${op.fromPath}`, err)
    await db.transaction(async (tx) => {
      await updateOpStatus(tx, op.id, 'FAILED', message)
      if (op.imageFileId !== null) {
        await restoreImageFiles(tx, [op.imageFileId], 'NORMAL')
      }
    })
    return message
  }
}

// 崩溃后收尾一步移动或复制：目标位置只有占位的空文件（或复制了一半）就删掉，算没做；
// 目标完整、来源已经不在（移动）或大小一致（复制）就算做完。库里的记录交给随后的扫描对账
// 日志里没有目标路径说明还没占到位置（或复制没完成），什么都不动
async function settleTransferOp(op: FileOpEntity): Promise<string | null> {
  const { db } = getDatabase()
  if (!op.toPath) {
    await updateOpStatus(db, op.id, 'REVERTED')
    return null
  }
  const to = await stat(op.toPath).catch(() => null)
  const from = await stat(op.fromPath).catch(() => null)
  const complete = !!to && (op.opType === 'MOVE' ? !from : !!from && from.size === to.size)
  if (to && !complete && from) {
    await unlink(op.toPath).catch((err: unknown) => log.warn(`清理没做完的目标文件失败：${op.toPath}`, err))
  }
  await updateOpStatus(db, op.id, complete ? 'DONE' : 'REVERTED')
  return null
}

// 退出前：等着进回收站的删除马上执行
export async function flushPendingDeletes(): Promise<void> {
  const ids = [...pending.keys()]
  await Promise.all(ids.map((id) => commitDelete(id)))
}

// 启动时对账：上次没做完的批次（崩溃、断电）按日志补做
export async function recoverFileOps(): Promise<number> {
  const batches = await findUnfinishedBatches()
  for (const b of batches) {
    if (!pending.has(b.id)) {
      log.info(`补做上次没做完的文件操作：批次 ${b.id}（${b.summary}）`)
      await enqueue(() => applyBatch(b.id))
    }
  }
  return batches.length
}

// 测试用：等队列里的操作都做完
export function settleFileOps(): Promise<unknown> {
  return queue
}
