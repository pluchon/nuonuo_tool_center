import { constants } from 'node:fs'
import { copyFile, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { GalleryQueryDTO, TransferResultVO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { isWithin } from '../../common/pathUtil'
import { getDatabase } from '../../db/client'
import {
  findBatch,
  findDoneOps,
  findImagesInDir,
  findPendingOps,
  insertBatch,
  insertCopiedFile,
  relocateImageFile,
  retireImageFile,
  retireRowsAt,
  updateBatchStatus,
  updateOpStatus,
  updateOpToPath,
  type FileOpEntity,
  type PlannedOp
} from '../../repositories/fileOpRepository'
import { findActiveRoots, type LibraryRootEntity } from '../../repositories/libraryRootRepository'
import type { GalleryRow } from '../../repositories/galleryRepository'
import { ensureCategoryRoot } from '../categoryHome'
import { filesForAction } from '../galleryService'
import { getScanState } from '../scan/scanService'
import { enqueue, trashPath } from './fileOpsService'

const log = getLogger('fileOps')

// 一次最多处理多少张（和多选上限一致）
const MAX_BATCH = 200
// 一次复制最多选几个目标目录
const MAX_TARGETS = 20
// 重名时最多试到几号
const MAX_SUFFIX = 999
// 做完后多久内还能撤销（提示条 5 秒，留点余量）
const UNDO_WINDOW_MS = 60_000

// 类目录位置的环境变量覆盖（启动时注入）
let categoryHomeOverride: string | null = null
export function configureTransfer(override: string | null): void {
  categoryHomeOverride = override
}

// 还能撤销的批次和截止时间
const undoable = new Map<number, number>()

// 错误信息
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 一个目标文件夹：它属于哪个图库目录、在里面的相对路径；不在图库里（“其他位置”）时 root 为空
interface Target {
  abs: string
  root: LibraryRootEntity | null
  relDir: string
}

// 校验目标文件夹：必须现在存在。在某个源目录或类目录（或它们的子文件夹）里就是图库里的目标；
// 否则是“其他位置”：复制过去等于导出一份（图库不变），移动过去等于把这张图移出图库（名字和标签留着，撤销可挪回）
async function resolveTarget(raw: unknown): Promise<Target> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BizError('BAD_REQUEST', '目标目录不对')
  }
  const abs = resolve(raw)
  await ensureCategoryRoot(categoryHomeOverride)
  const roots = (await findActiveRoots()).filter((r) => isWithin(r.path, abs))
  // 嵌套时取最深的那个
  const root = roots.sort((a, b) => b.path.length - a.path.length)[0] ?? null
  const ok = await stat(abs)
    .then((s) => s.isDirectory())
    .catch(() => false)
  if (!ok) {
    throw new BizError('NOT_FOUND', `找不到目标目录：${abs}`)
  }
  return { abs, root, relDir: root ? relative(root.path, abs) : '' }
}

// 每张图挑一个来源位置：正常且目录在线的优先
function pickSources(rows: Array<GalleryRow & { offline: boolean }>): Array<GalleryRow & { offline: boolean }> {
  const byImage = new Map<number, Array<GalleryRow & { offline: boolean }>>()
  for (const r of rows.filter((x) => !x.offline)) {
    byImage.set(r.imageId, [...(byImage.get(r.imageId) ?? []), r])
  }
  return [...byImage.values()].map((list) => list.find((r) => r.fileStatus === 'NORMAL') ?? list[0])
}

// 第 n 个候选文件名：a.jpg、a (2).jpg、a (3).jpg……
function candidate(dir: string, name: string, n: number): string {
  if (n === 1) {
    return join(dir, name)
  }
  const ext = extname(name)
  return join(dir, `${basename(name, ext)} (${n})${ext}`)
}

// 占一个不重名的位置：用独占方式建一个空文件，确保不会覆盖已有文件
async function reserve(dir: string, name: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const path = candidate(dir, name, n)
    try {
      const handle = await open(path, 'wx')
      await handle.close()
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err
      }
    }
  }
  throw new Error('同名文件太多了')
}

// 把文件挪到已经占好的位置（覆盖的只是自己建的空占位文件）；跨盘时先复制再删原文件
async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw err
    }
    await copyFile(from, to)
    await unlink(from)
  }
}

// 复制到一个不重名的位置（排他复制：目标已存在就换下一个编号）
async function copyInto(from: string, dir: string, name: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const path = candidate(dir, name, n)
    try {
      await copyFile(from, path, constants.COPYFILE_EXCL)
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err
      }
    }
  }
  throw new Error('同名文件太多了')
}

// 公共校验：图片 id、扫描中不能动文件
function checkIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((v) => !Number.isInteger(v))) {
    throw new BizError('BAD_REQUEST', '没有选中图片')
  }
  const ids = [...new Set(raw as number[])]
  if (ids.length > MAX_BATCH) {
    throw new BizError('BAD_REQUEST', `一次最多处理 ${MAX_BATCH} 张`)
  }
  if (getScanState().progress) {
    throw new BizError('CONFLICT', '正在扫描，等扫完再移动或复制')
  }
  return ids
}

// 记一个批次的结果，做成过的才能撤销
async function finish(batchId: number, done: number, failed: number): Promise<void> {
  const { db } = getDatabase()
  await updateBatchStatus(db, batchId, done === 0 && failed > 0 ? 'FAILED' : 'APPLIED')
  if (done > 0) {
    undoable.set(batchId, Date.now() + UNDO_WINDOW_MS)
  }
}

// 移动到一个目录：每张图挑一个位置挪过去（已经在那里的跳过），重名自动加编号，记录跟着改
export async function moveImages(query: GalleryQueryDTO, rawIds: unknown, rawTarget: unknown): Promise<TransferResultVO> {
  const ids = checkIds(rawIds)
  const target = await resolveTarget(rawTarget)
  const sources = pickSources(await filesForAction(query, ids))
  if (sources.length === 0) {
    throw new BizError('DEPENDENCY_FAILED', '原图暂时打不开，没法移动')
  }
  const todo = sources.filter((r) => resolve(dirname(join(r.rootPath, r.relPath))).toLowerCase() !== target.abs.toLowerCase())
  const skipped = sources.length - todo.length
  if (todo.length === 0) {
    return { batchId: null, done: 0, skipped, failed: 0, error: null }
  }
  return enqueue(async () => {
    const { db } = getDatabase()
    const ops: PlannedOp[] = todo.map((r) => ({
      opType: 'MOVE',
      imageFileId: r.fileId,
      fromPath: join(r.rootPath, r.relPath),
      // 目标路径在独占占位成功后才写进日志：崩溃后收尾只会动确定是自己建的文件
      toPath: null,
      contentHash: r.contentHash
    }))
    const batchId = await db.transaction(async (tx) => {
      const id = await insertBatch(tx, `移动 ${todo.length} 张到「${basename(target.abs)}」`, ops)
      await updateBatchStatus(tx, id, 'APPLYING')
      return id
    })
    const planned = await opsOf(batchId)
    let done = 0
    let failed = 0
    let error: string | null = null
    for (const op of planned) {
      let reserved: string | null = null
      try {
        reserved = await reserve(target.abs, basename(op.fromPath))
        const to = reserved
        await updateOpToPath(db, op.id, to)
        await moveInto(op.fromPath, to)
        reserved = null
        const root = target.root
        await db.transaction(async (tx) => {
          if (root) {
            const rel = relative(root.path, to)
            await retireRowsAt(tx, root.id, rel)
            await relocateImageFile(tx, op.imageFileId!, root.id, rel)
          } else {
            // 移到图库外：这个位置从图库里去掉
            await retireImageFile(tx, op.imageFileId!)
          }
          await updateOpStatus(tx, op.id, 'DONE')
        })
        done += 1
      } catch (err) {
        failed += 1
        error ??= reason(err)
        log.warn(`移动失败：${op.fromPath}`, err)
        if (reserved) {
          await unlink(reserved).catch(() => undefined)
        }
        await updateOpStatus(db, op.id, 'FAILED', reason(err))
      }
    }
    await finish(batchId, done, failed)
    return { batchId: done > 0 ? batchId : null, done, skipped, failed, error }
  })
}

// 复制到一个或多个目录：每张图挑一个位置复制过去（那个目录里已有这张图的跳过），重名自动加编号，记录挂在同一张图上
export async function copyImages(query: GalleryQueryDTO, rawIds: unknown, rawTargets: unknown): Promise<TransferResultVO> {
  const ids = checkIds(rawIds)
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new BizError('BAD_REQUEST', '先选要复制到的目录')
  }
  if (rawTargets.length > MAX_TARGETS) {
    throw new BizError('BAD_REQUEST', `一次最多复制到 ${MAX_TARGETS} 个目录`)
  }
  const targets: Target[] = []
  for (const raw of rawTargets) {
    const t = await resolveTarget(raw)
    if (!targets.some((x) => x.abs.toLowerCase() === t.abs.toLowerCase())) {
      targets.push(t)
    }
  }
  const sources = pickSources(await filesForAction(query, ids))
  if (sources.length === 0) {
    throw new BizError('DEPENDENCY_FAILED', '原图暂时打不开，没法复制')
  }
  return enqueue(async () => {
    const { db } = getDatabase()
    const pairs: Array<{ row: (typeof sources)[number]; target: Target }> = []
    let skipped = 0
    for (const target of targets) {
      // 图库外的目录不知道里面有什么，同名的自动加编号
      const has = target.root
        ? await findImagesInDir(
            db,
            sources.map((s) => s.imageId),
            target.root.id,
            target.relDir
          )
        : new Set<number>()
      for (const row of sources) {
        if (has.has(row.imageId)) {
          skipped += 1
        } else {
          pairs.push({ row, target })
        }
      }
    }
    if (pairs.length === 0) {
      return { batchId: null, done: 0, skipped, failed: 0, error: null }
    }
    const batchId = await db.transaction(async (tx) => {
      const id = await insertBatch(
        tx,
        `复制 ${sources.length} 张到 ${targets.length} 个目录`,
        pairs.map(({ row, target }) => ({
          opType: 'COPY' as const,
          imageFileId: row.fileId,
          fromPath: join(row.rootPath, row.relPath),
          // 复制完成后才写目标路径（同一个事务里标成做完）
          toPath: null,
          contentHash: row.contentHash
        }))
      )
      await updateBatchStatus(tx, id, 'APPLYING')
      return id
    })
    const planned = await opsOf(batchId)
    let done = 0
    let failed = 0
    let error: string | null = null
    for (const [i, op] of planned.entries()) {
      const { row, target } = pairs[i]
      try {
        const to = await copyInto(op.fromPath, target.abs, basename(op.fromPath))
        const mtime = (await stat(to)).mtime
        const root = target.root
        await db.transaction(async (tx) => {
          await updateOpToPath(tx, op.id, to)
          // 图库外的副本不登记
          if (root) {
            const rel = relative(root.path, to)
            await retireRowsAt(tx, root.id, rel)
            await insertCopiedFile(tx, { imageId: row.imageId, rootId: root.id, relPath: rel, mtime })
          }
          await updateOpStatus(tx, op.id, 'DONE')
        })
        done += 1
      } catch (err) {
        failed += 1
        error ??= reason(err)
        log.warn(`复制失败：${op.fromPath} → ${target.abs}`, err)
        await updateOpStatus(db, op.id, 'FAILED', reason(err))
      }
    }
    await finish(batchId, done, failed)
    return { batchId: done > 0 ? batchId : null, done, skipped, failed, error }
  })
}

// 批次里全部步骤（按顺序）
function opsOf(batchId: number): Promise<FileOpEntity[]> {
  return findPendingOps(batchId)
}

// 撤销移动或复制：移动的挪回原处（原处被占了就留在新位置），复制出来的放进回收站
export async function undoTransfer(rawId: unknown): Promise<TransferResultVO> {
  if (!Number.isInteger(rawId)) {
    throw new BizError('BAD_REQUEST', '操作 id 不对')
  }
  const batchId = rawId as number
  const deadline = undoable.get(batchId)
  if (!deadline || deadline < Date.now()) {
    throw new BizError('CONFLICT', '这一步已经不能撤销了')
  }
  return enqueue(async () => {
    const batch = await findBatch(batchId)
    if (!batch || batch.status !== 'APPLIED') {
      throw new BizError('CONFLICT', '这一步已经不能撤销了')
    }
    undoable.delete(batchId)
    const { db } = getDatabase()
    const roots = await findActiveRoots()
    const locate = (abs: string): { root: LibraryRootEntity; rel: string } | null => {
      const root = roots.filter((r) => isWithin(r.path, abs)).sort((a, b) => b.path.length - a.path.length)[0]
      return root ? { root, rel: relative(root.path, abs) } : null
    }
    let done = 0
    let failed = 0
    let error: string | null = null
    for (const op of await findDoneOps(batchId)) {
      try {
        if (!op.toPath) {
          continue
        }
        if (op.opType === 'MOVE') {
          const back = locate(op.fromPath)
          if (!back) {
            throw new Error('原来的目录已经不在图库里了')
          }
          // 原处独占建占位：被别的文件占了就不挪回去
          const handle = await open(op.fromPath, 'wx')
          await handle.close()
          try {
            await moveInto(op.toPath, op.fromPath)
          } catch (err) {
            await unlink(op.fromPath).catch(() => undefined)
            throw err
          }
          await db.transaction(async (tx) => {
            await retireRowsAt(tx, back.root.id, back.rel)
            await relocateImageFile(tx, op.imageFileId!, back.root.id, back.rel)
            await updateOpStatus(tx, op.id, 'REVERTED')
          })
        } else {
          const at = locate(op.toPath)
          await trashPath(op.toPath)
          await db.transaction(async (tx) => {
            if (at) {
              await retireRowsAt(tx, at.root.id, at.rel)
            }
            await updateOpStatus(tx, op.id, 'REVERTED')
          })
        }
        done += 1
      } catch (err) {
        failed += 1
        error ??= (err as NodeJS.ErrnoException).code === 'EEXIST' ? '原来的位置已经有同名文件了' : reason(err)
        log.warn(`撤销失败：${op.fromPath}`, err)
      }
    }
    await updateBatchStatus(db, batchId, 'UNDONE')
    return { batchId, done, skipped: 0, failed, error }
  })
}
