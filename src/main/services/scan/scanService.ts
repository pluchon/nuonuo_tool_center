import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { ScanProgressVO, ScanResultVO, ScanStateVO } from '@shared/api'
import type { AppSettings } from '@shared/settings'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { isWithin, pathKey } from '../../common/pathUtil'
import {
  findScanRowsByRoot,
  insertImageFile,
  latestFileId,
  softDeleteImageFiles,
  updateImageFileContent,
  updateImageFileStatus,
  type ScanFileRow
} from '../../repositories/imageFileRepository'
import { findHiddenRelPaths } from '../../repositories/fileOpRepository'
import {
  findImageByHash,
  insertImageOrGet,
  THUMB_FAILED,
  THUMB_READY,
  updateImageAnalysis,
  type ImageEntity
} from '../../repositories/imageRepository'
import {
  findActiveRootById,
  findActiveRoots,
  updateRootLastScan,
  type LibraryRootEntity
} from '../../repositories/libraryRootRepository'
import { ensureCategoryRoot } from '../categoryHome'
import { loadCheckpoint, PENDING_AUTO_SCANS, saveCheckpoint, SCAN_CHECKPOINT } from '../progressCheckpoint'
import { getSettings } from '../settingsService'
import { shouldProcess } from './formats'
import { analyzeImage, hashBuffer, hashFile, READ_ONCE_LIMIT } from './imageProbe'
import { RootUnavailableError, walkRoot, type WalkedFile, type WalkResult } from './walker'

const log = getLogger('scan')

// 同时处理的文件数：每路 sharp 只用 1 个线程，按核数取 2–4 路（16 核的机器 4 路，只占四分之一的核，整机不卡）。
// 实测 3000×2000 照片：2 路约 30 ms/张，读一次 + 4 路约 11 ms/张
export const WORKERS = Math.min(4, Math.max(2, Math.floor(cpus().length / 4)))
// 进度推送的最小间隔（毫秒）
const PUSH_INTERVAL = 150
// 批量更新时一次最多带多少个 id
const ID_CHUNK = 500
const CHECKPOINT_FILES = 32
const CHECKPOINT_MS = 2000

// 扫描需要的位置
export interface ScanConfig {
  thumbsDir: string
  categoryHomeOverride: string | null
  canRunAuto?: () => boolean
}

// 一个排队的扫描任务：rootId 为空表示扫描全部（含类目录）；auto 表示启动时自动发起的（完成时不弹提示）
interface ScanJob {
  rootId: number | null
  auto: boolean
  resume?: ScanCheckpoint
}

type ScanFilters = Pick<AppSettings, 'scanFormats' | 'skipSmall'>

// 任务启动即落盘，处理中分批更新；记录发起时的筛选条件。
interface ScanCheckpoint {
  rootId: number | null
  auto: boolean
  done: number
  total: number
  filters?: ScanFilters
  startFileId?: number
}

// 一个目录这次要处理的内容
interface RootPlan {
  root: LibraryRootEntity
  walk: WalkResult
  // 要处理（算哈希、建记录）的文件：按设置过滤过格式和小图
  todo: WalkedFile[]
}

let config: ScanConfig | null = null
let listener: (state: ScanStateVO) => void = () => undefined
const queue: ScanJob[] = []
let current: ScanJob | null = null
let progress: ScanProgressVO | null = null
let last: ScanResultVO | null = null
let stopRequested = false
let running: Promise<void> | null = null
let lastPush = 0
// 这一轮实际处理了几个文件，和上次退出时已经扫到的数（显示的进度取两者大的，不倒退）
let processed = 0
let floor = 0
// 正在退出：被打断的扫描留着断点，不清
let quitting = false

// 启动时调用一次：缩略图目录、类目录位置
export function configureScan(next: ScanConfig): void {
  config = next
}

// 扫描状态变化时的回调（主进程用它把状态推给窗口）
export function onScanState(fn: (state: ScanStateVO) => void): void {
  listener = fn
}

// 当前扫描状态
export function getScanState(): ScanStateVO {
  return { progress: progress ? { ...progress } : null, last }
}

export function isScanningRoot(rootId: number): boolean {
  return current !== null && (current.rootId === null || current.rootId === rootId)
}

// 推送状态；进度更新按间隔节流，开始和结束总是推
function push(force: boolean): void {
  const now = Date.now()
  if (!force && now - lastPush < PUSH_INTERVAL) {
    return
  }
  lastPush = now
  listener(getScanState())
}

// 排一个扫描任务：rootId 为空扫全部。已经排着或正在扫的任务覆盖了它就不重复排；用户手动要求的会把自动任务改成手动（完成时弹提示）
export function startScan(rootId: number | null, auto = false): ScanStateVO {
  return enqueueScan({ rootId, auto })
}

function enqueueScan(job: ScanJob): ScanStateVO {
  const { rootId, auto } = job
  const queued = queue.find((j) => j.rootId === rootId || (j.rootId === null && (auto || !j.auto)))
  const inCurrent =
    current !== null &&
    !stopRequested &&
    (current.rootId === rootId || (rootId !== null && progress !== null && progress.rootIds.includes(rootId)))
  const covering = queued ?? (inCurrent ? current : null)
  if (covering) {
    covering.auto = covering.auto && auto
    if (job.resume) covering.resume = job.resume
  } else {
    if (rootId === null) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].auto && !queue[i].resume) queue.splice(i, 1)
      }
    }
    queue.push(job)
  }
  runQueuedScans()
  return getScanState()
}

// 文件有变化（实时监听）后重扫一个目录：正在扫的这一轮可能已经走过变化的地方，所以只要队列里还没有就再排一次
export function requeueScan(rootId: number): void {
  if (queue.some((j) => j.rootId === null || j.rootId === rootId)) {
    return
  }
  queue.push({ rootId, auto: true })
  runQueuedScans()
}

function canRun(job: ScanJob): boolean {
  return !job.auto || config?.canRunAuto?.() !== false
}

export function runQueuedScans(): void {
  if (!quitting && !running && queue.some(canRun)) {
    running = drain().catch((err: unknown) => {
      log.error('扫描队列处理失败', err)
      return false
    }).then((drained) => {
      running = null
      if (drained) runQueuedScans()
    })
  }
}

// 停止扫描：当前任务处理完手上的文件就结束，排队的任务一并取消；已经找到的图都保留
export function stopScan(): ScanStateVO {
  if (current) {
    stopRequested = true
  }
  queue.length = 0
  return getScanState()
}

// 等扫描结束（退出应用前用）：先要求停止，再等手上的文件写完；还没扫完的记下断点，下次启动接着扫
export async function stopScanAndWait(): Promise<void> {
  quitting = true
  const pending = queue.filter((job) => job.auto).map((job) => job.rootId)
  stopScan()
  await running
  if (pending.length > 0) {
    await saveCheckpoint(PENDING_AUTO_SCANS, { roots: pending })
  }
}

// 启动时：上次退出时没扫完的接着扫（不管“启动时自动扫描”开没开）；返回有没有接着扫
export async function resumeScan(): Promise<boolean> {
  const cp = await loadCheckpoint<ScanCheckpoint>(SCAN_CHECKPOINT)
  if (cp) {
    log.info(`恢复扫描断点 ${cp.done}/${cp.total}`)
    enqueueScan({ rootId: cp.rootId ?? null, auto: cp.auto !== false, resume: cp })
  }
  const pending = await loadCheckpoint<{ roots?: Array<number | null> }>(PENDING_AUTO_SCANS)
  const roots = Array.isArray(pending?.roots) ? pending.roots : []
  if (roots.length > 0) {
    await saveCheckpoint(PENDING_AUTO_SCANS, null)
    for (const id of roots) {
      if (id === null || Number.isInteger(id)) startScan(id, true)
    }
  }
  return !!cp || roots.includes(null)
}

// 等排队的扫描全部做完（不打断）
export async function whenScanIdle(): Promise<void> {
  while (running) {
    await running
  }
}

// 依次执行排队的任务
async function drain(): Promise<boolean> {
  for (let index = queue.findIndex(canRun); !quitting && index >= 0; index = queue.findIndex(canRun)) {
    const [job] = queue.splice(index, 1)
    current = job
    stopRequested = false
    let completed = false
    try {
      last = { ...(await runJob(job)), auto: job.auto }
      completed = !last.stopped || !quitting
    } catch (err) {
      log.error('扫描失败', err)
      completed = err instanceof BizError && err.code === 'NOT_FOUND'
      last = { rootName: null, total: 0, found: 0, added: 0, stopped: false, failed: 0, unreadableDirs: 0,
        error: err instanceof BizError ? err.message : '扫描失败，请重新扫描', auto: job.auto, finishedAt: new Date().toISOString() }
    } finally {
      current = null
      progress = null
      // 成功或主动停止才清断点。异常退出或处理失败时，留给下次启动恢复。
      if (completed) {
        await saveCheckpoint(SCAN_CHECKPOINT, null).catch((err: unknown) => log.warn('清扫描断点失败', err))
      }
      push(true)
    }
    if (!completed) return false
  }
  return true
}

// 这次要扫的目录：扫全部时先确保类目录登记过
async function rootsOf(job: ScanJob): Promise<LibraryRootEntity[]> {
  if (!config) {
    throw new Error('扫描服务还没配置')
  }
  if (job.rootId === null) {
    await ensureCategoryRoot(config.categoryHomeOverride)
    return findActiveRoots()
  }
  const root = await findActiveRootById(job.rootId)
  if (!root) {
    throw new BizError('NOT_FOUND', '这个目录已经不在图库里了')
  }
  return [root]
}

// 执行一个任务：先遍历所有目录得到总数，再逐个文件处理，最后对账
async function runJob(job: ScanJob): Promise<Omit<ScanResultVO, 'auto'>> {
  const checkpoint = job.resume
  let { done, total } = checkpoint ?? { done: 0, total: 0 }
  let filters = checkpoint?.filters
  const startFileId = checkpoint?.startFileId ?? await latestFileId()
  const persist = (): Promise<void> => saveCheckpoint(SCAN_CHECKPOINT, { rootId: job.rootId, auto: job.auto, done, total, filters, startFileId })
  await persist()
  if (!filters) {
    const { scanFormats, skipSmall } = await getSettings()
    filters = { scanFormats, skipSmall }
    await persist()
  }
  const roots = await rootsOf(job)
  const single = job.rootId !== null ? roots[0] : null
  // 上次退出时同一个任务扫到哪了（之前扫过的文件这次会很快跳过，进度直接从那里显示）
  processed = 0
  floor = Number(done) || 0
  progress = { rootName: single?.name ?? null, rootIds: roots.map((r) => r.id), done: 0, total: 0, found: 0 }
  push(true)

  const plans: RootPlan[] = []
  let unreadableDirs = 0
  for (const root of roots) {
    if (stopRequested) {
      break
    }
    try {
      const walk = await walkRoot(root.path, () => stopRequested)
      unreadableDirs += walk.unreadableDirs.length
      const todo = walk.files.filter((f) => shouldProcess(f.format, f.size, filters.scanFormats, filters.skipSmall))
      plans.push({ root, walk, todo })
      progress.total += todo.length
      push(false)
    } catch (err) {
      // 目录找不到（移动硬盘没接）：这个目录的记录一条都不动，侧栏显示“找不到”
      if (err instanceof RootUnavailableError) {
        unreadableDirs++
        log.warn(`跳过找不到的目录：${root.path}`)
        continue
      }
      throw err
    }
  }

  // 数完文件、开始处理前就显示上次扫到的位置
  progress.done = Math.min(progress.total, floor)
  if (!stopRequested) {
    total = progress.total
    done = progress.done
    await persist()
  }
  push(true)
  let checkpointAt = Date.now()
  let checkpointProcessed = 0
  const saveProgress = async (): Promise<void> => {
    if (processed - checkpointProcessed < CHECKPOINT_FILES && Date.now() - checkpointAt < CHECKPOINT_MS) return
    checkpointProcessed = processed
    checkpointAt = Date.now()
    done = progress!.done
    await persist()
  }
  const outcomes: RootOutcome[] = []
  for (const plan of plans) {
    if (stopRequested) {
      break
    }
    const outcome = await scanRoot(plan, saveProgress, startFileId)
    outcomes.push(outcome)
  }
  // 所有目录都处理完再对账：文件从一个源目录挪到另一个时，先扫到的那边不会被误标成“不见了”
  // 中途停止或遍历被打断时不对账：没扫到的文件不能当成“不见了”
  if (!stopRequested) {
    for (const outcome of outcomes) {
      await reconcileMissing(outcome.rows, outcome.present, outcome.plan.walk.unreadableDirs)
      await updateRootLastScan(outcome.plan.root.id, new Date())
    }
  }
  if (quitting && stopRequested) {
    done = Math.max(done, progress.done)
    await persist()
  }
  const finishedAt = new Date()
  return {
    rootName: progress.rootName,
    total: progress.total,
    found: progress.found,
    added: outcomes.reduce((sum, root) => sum + root.added, 0),
    stopped: stopRequested,
    failed: outcomes.reduce((sum, root) => sum + root.failed, 0),
    unreadableDirs,
    finishedAt: finishedAt.toISOString()
  }
}

// 一个目录处理完的结果：对账要用的旧记录和磁盘上还在的文件
interface RootOutcome {
  plan: RootPlan
  rows: ScanFileRow[]
  present: Set<string>
  failed: number
  added: number
}

// 扫一个目录：逐个处理要处理的文件（新文件、变了的文件登记，重新出现的改回正常）
async function scanRoot(plan: RootPlan, saveProgress: () => Promise<void>, startFileId: number): Promise<RootOutcome> {
  const { root, walk, todo } = plan
  const rows = await findScanRowsByRoot(root.id)
  const byKey = new Map(rows.map((r) => [pathKey(r.relPath), r]))
  // 刚删除、还在撤销窗口里等着进回收站的文件：不能当成新文件再登记一遍
  const hidden = new Set((await findHiddenRelPaths(root.id)).map(pathKey))
  // 缩略图文件夹里现有的文件：记着“已生成”但文件没了（手动清过缓存）的，当成变了的文件重新登记，补回缩略图
  const thumbs = new Set(await readdir(config!.thumbsDir).catch(() => [] as string[]))
  // 磁盘上还在的文件（含这次按设置不处理的、读不了的）：它们的记录不能当成“不见了”
  const present = new Set([...walk.files.map((f) => pathKey(f.relPath)), ...walk.unreadableFiles.map(pathKey)])
  const reappeared: number[] = []
  let failed = walk.unreadableFiles.length
  let added = 0
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < todo.length && !stopRequested) {
      const file = todo[next++]
      const row = byKey.get(pathKey(file.relPath))
      try {
        if (row || !hidden.has(pathKey(file.relPath))) {
          if (row && isUnchanged(row, file) && (row.thumbReady !== THUMB_READY || thumbs.has(`${row.hash}.webp`))) {
            if (row.relPath !== file.relPath) {
              // Windows 文件名可以只改大小写，更新显示路径并保留已有图片和标签。
              await updateImageFileContent(row.id, { imageId: row.imageId, relPath: file.relPath, mtime: file.mtime })
            } else if (row.status !== 'NORMAL') {
              reappeared.push(row.id)
            }
          } else {
            await registerFile(root, file, row)
          }
          if (!row || row.id > startFileId) added++
          progress!.found += 1
        }
      } catch (err) {
        // 读失败（被占用、没权限）：保持原状态，下次扫描再试
        failed += 1
        present.add(pathKey(file.relPath))
        log.warn(`处理文件失败：${join(root.path, file.relPath)}`, err)
      }
      processed += 1
      progress!.done = Math.min(progress!.total, Math.max(floor, processed))
      await saveProgress().catch((err: unknown) => log.warn('保存扫描断点失败', err))
      push(false)
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
  await chunked(reappeared, (ids) => updateImageFileStatus(ids, 'NORMAL'))
  return { plan, rows, present, failed, added }
}

// 文件没变：修改时间和大小都和记录一致，且缩略图已经处理过（成功或确定失败）
function isUnchanged(row: ScanFileRow, file: WalkedFile): boolean {
  return row.mtime.getTime() === file.mtime.getTime() && row.byteSize === file.size && row.thumbReady !== 0
}

// 登记一个新文件或内容变了的文件：算哈希，按哈希找或建图片，缺缩略图就补，再写文件记录
async function registerFile(root: LibraryRootEntity, file: WalkedFile, row: ScanFileRow | undefined): Promise<void> {
  const abs = join(root.path, file.relPath)
  // 一般大小的文件只读一次：同一份内容算哈希、解码、写缩略图
  const data = file.size <= READ_ONCE_LIMIT ? await readFile(abs) : null
  const hash = data ? hashBuffer(data) : await hashFile(abs)
  const img = await ensureImage(hash, abs, file, data)
  if (row) {
    await updateImageFileContent(row.id, { imageId: img.id, relPath: file.relPath, mtime: file.mtime })
  } else {
    await insertImageFile({ imageId: img.id, rootId: root.id, relPath: file.relPath, mtime: file.mtime })
  }
}

// 按哈希找图片；没有就解析后新建。已有的图片缺缩略图（文件被清掉或上次失败）时重新生成
async function ensureImage(hash: string, abs: string, file: WalkedFile, data: Buffer | null): Promise<ImageEntity> {
  const thumbPath = join(config!.thumbsDir, `${hash}.webp`)
  const existing = await findImageByHash(hash)
  if (existing && existing.thumbReady === THUMB_READY && existsSync(thumbPath)) {
    return existing
  }
  const needThumb = existsSync(thumbPath) ? null : thumbPath
  const info = await analyzeImage(abs, file.format, needThumb, data)
  const thumbReady = needThumb === null || info.thumbnail ? THUMB_READY : THUMB_FAILED
  const analysis = { width: info.width, height: info.height, exif: info.exif, takenAt: info.takenAt, thumbReady }
  if (existing) {
    await updateImageAnalysis(existing.id, analysis)
    return existing
  }
  return insertImageOrGet({ contentHash: hash, format: file.format, byteSize: file.size, ...analysis })
}

// 对账：记录里有、磁盘上没有的文件，从图库里去掉（逻辑删除这条文件记录）。所在子目录读不了的不动（目录离线另有提示）。
// 图片本身（名字、标签）留着：文件放回来（从回收站还原）后再扫描，按内容哈希认回来
async function reconcileMissing(rows: ScanFileRow[], present: Set<string>, unreadableDirs: string[]): Promise<void> {
  const gone = rows.filter(
    (r) => !present.has(pathKey(r.relPath)) && !unreadableDirs.some((d) => isWithin(d, r.relPath))
  )
  if (gone.length === 0) {
    return
  }
  await chunked(
    gone.map((r) => r.id),
    softDeleteImageFiles
  )
  log.info(`对账：${gone.length} 个文件已经不在磁盘上，从图库里去掉`)
}

// 分批执行，避免一条 SQL 带太多参数
async function chunked(ids: number[], fn: (part: number[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    await fn(ids.slice(i, i + ID_CHUNK))
  }
}
