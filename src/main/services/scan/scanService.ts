import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ScanProgressVO, ScanResultVO, ScanStateVO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { isWithin, pathKey } from '../../common/pathUtil'
import {
  findImagesWithOtherNormalFile,
  findScanRowsByRoot,
  insertImageFile,
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
import { getSettings } from '../settingsService'
import { shouldProcess } from './formats'
import { analyzeImage, hashFile } from './imageProbe'
import { RootUnavailableError, walkRoot, type WalkedFile, type WalkResult } from './walker'

const log = getLogger('scan')

// 同时处理的文件数：读盘和 sharp 都是异步的，2 路就能占满，再多会拖慢整机
const WORKERS = 2
// 进度推送的最小间隔（毫秒）
const PUSH_INTERVAL = 150
// 批量更新时一次最多带多少个 id
const ID_CHUNK = 500

// 扫描需要的位置
export interface ScanConfig {
  thumbsDir: string
  categoryHomeOverride: string | null
}

// 一个排队的扫描任务：rootId 为空表示扫描全部（含类目录）；auto 表示启动时自动发起的（完成时不弹提示）
interface ScanJob {
  rootId: number | null
  auto: boolean
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
  const queued = queue.find((j) => j.rootId === null || j.rootId === rootId)
  const inCurrent =
    current !== null &&
    !stopRequested &&
    (current.rootId === rootId || (rootId !== null && progress !== null && progress.rootIds.includes(rootId)))
  const covering = queued ?? (inCurrent ? current : null)
  if (covering) {
    covering.auto = covering.auto && auto
  } else {
    queue.push({ rootId, auto })
  }
  if (!running) {
    running = drain().finally(() => {
      running = null
    })
  }
  return getScanState()
}

// 文件有变化（实时监听）后重扫一个目录：正在扫的这一轮可能已经走过变化的地方，所以只要队列里还没有就再排一次
export function requeueScan(rootId: number): void {
  if (queue.some((j) => j.rootId === null || j.rootId === rootId)) {
    return
  }
  queue.push({ rootId, auto: true })
  if (!running) {
    running = drain().finally(() => {
      running = null
    })
  }
}

// 停止扫描：当前任务处理完手上的文件就结束，排队的任务一并取消；已经找到的图都保留
export function stopScan(): ScanStateVO {
  if (progress) {
    stopRequested = true
  }
  queue.length = 0
  return getScanState()
}

// 等扫描结束（退出应用前用）：先要求停止，再等手上的文件写完
export async function stopScanAndWait(): Promise<void> {
  stopScan()
  await running
}

// 等排队的扫描全部做完（不打断）
export async function whenScanIdle(): Promise<void> {
  while (running) {
    await running
  }
}

// 依次执行排队的任务
async function drain(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift() as ScanJob
    current = job
    stopRequested = false
    try {
      last = { ...(await runJob(job)), auto: job.auto }
    } catch (err) {
      log.error('扫描失败', err)
      last = { rootName: null, total: 0, found: 0, stopped: true, failed: 0, auto: job.auto, finishedAt: new Date().toISOString() }
    } finally {
      current = null
      progress = null
      push(true)
    }
  }
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
  const settings = await getSettings()
  const roots = await rootsOf(job)
  const single = job.rootId !== null ? roots[0] : null
  progress = { rootName: single?.name ?? null, rootIds: roots.map((r) => r.id), done: 0, total: 0, found: 0 }
  push(true)

  const plans: RootPlan[] = []
  for (const root of roots) {
    if (stopRequested) {
      break
    }
    try {
      const walk = await walkRoot(root.path, () => stopRequested)
      const todo = walk.files.filter((f) => shouldProcess(f.format, f.size, settings.scanFormats, settings.skipSmall))
      plans.push({ root, walk, todo })
      progress.total += todo.length
      push(false)
    } catch (err) {
      // 目录找不到（移动硬盘没接）：这个目录的记录一条都不动，侧栏显示“找不到”
      if (err instanceof RootUnavailableError) {
        log.warn(`跳过找不到的目录：${root.path}`)
        continue
      }
      throw err
    }
  }

  let failed = 0
  const outcomes: RootOutcome[] = []
  for (const plan of plans) {
    if (stopRequested) {
      break
    }
    const outcome = await scanRoot(plan)
    failed += outcome.failed
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
  const finishedAt = new Date()
  return {
    rootName: progress.rootName,
    total: progress.total,
    found: progress.found,
    stopped: stopRequested,
    failed,
    finishedAt: finishedAt.toISOString()
  }
}

// 一个目录处理完的结果：对账要用的旧记录和磁盘上还在的文件
interface RootOutcome {
  plan: RootPlan
  rows: ScanFileRow[]
  present: Set<string>
  failed: number
}

// 扫一个目录：逐个处理要处理的文件（新文件、变了的文件登记，重新出现的改回正常）
async function scanRoot(plan: RootPlan): Promise<RootOutcome> {
  const { root, walk, todo } = plan
  const rows = await findScanRowsByRoot(root.id)
  const byKey = new Map(rows.map((r) => [pathKey(r.relPath), r]))
  // 刚删除、还在撤销窗口里等着进回收站的文件：不能当成新文件再登记一遍
  const hidden = new Set((await findHiddenRelPaths(root.id)).map(pathKey))
  // 磁盘上还在的文件（含这次按设置不处理的、读不了的）：它们的记录不能当成“不见了”
  const present = new Set([...walk.files.map((f) => pathKey(f.relPath)), ...walk.unreadableFiles.map(pathKey)])
  const reappeared: number[] = []
  let failed = 0
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < todo.length && !stopRequested) {
      const file = todo[next++]
      const row = byKey.get(pathKey(file.relPath))
      try {
        if (!row && hidden.has(pathKey(file.relPath))) {
          // 等着进回收站的文件：不登记，计入已处理
        } else if (row && isUnchanged(row, file)) {
          if (row.status !== 'NORMAL') {
            reappeared.push(row.id)
          }
        } else {
          await registerFile(root, file, row)
        }
        progress!.found += 1
      } catch (err) {
        // 读失败（被占用、没权限）：保持原状态，下次扫描再试
        failed += 1
        present.add(pathKey(file.relPath))
        log.warn(`处理文件失败：${join(root.path, file.relPath)}`, err)
      }
      progress!.done += 1
      push(false)
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
  await chunked(reappeared, (ids) => updateImageFileStatus(ids, 'NORMAL'))
  return { plan, rows, present, failed }
}

// 文件没变：修改时间和大小都和记录一致，且缩略图已经处理过（成功或确定失败）
function isUnchanged(row: ScanFileRow, file: WalkedFile): boolean {
  return row.mtime.getTime() === file.mtime.getTime() && row.byteSize === file.size && row.thumbReady !== 0
}

// 登记一个新文件或内容变了的文件：算哈希，按哈希找或建图片，缺缩略图就补，再写文件记录
async function registerFile(root: LibraryRootEntity, file: WalkedFile, row: ScanFileRow | undefined): Promise<void> {
  const abs = join(root.path, file.relPath)
  const hash = await hashFile(abs)
  const img = await ensureImage(hash, abs, file)
  if (row) {
    await updateImageFileContent(row.id, { imageId: img.id, relPath: file.relPath, mtime: file.mtime })
  } else {
    await insertImageFile({ imageId: img.id, rootId: root.id, relPath: file.relPath, mtime: file.mtime })
  }
}

// 按哈希找图片；没有就解析后新建。已有的图片缺缩略图（文件被清掉或上次失败）时重新生成
async function ensureImage(hash: string, abs: string, file: WalkedFile): Promise<ImageEntity> {
  const thumbPath = join(config!.thumbsDir, `${hash}.webp`)
  const existing = await findImageByHash(hash)
  if (existing && existing.thumbReady === THUMB_READY && existsSync(thumbPath)) {
    return existing
  }
  const needThumb = existsSync(thumbPath) ? null : thumbPath
  const info = await analyzeImage(abs, file.format, needThumb)
  const thumbReady = needThumb === null || info.thumbnail ? THUMB_READY : THUMB_FAILED
  const analysis = { width: info.width, height: info.height, exif: info.exif, takenAt: info.takenAt, thumbReady }
  if (existing) {
    await updateImageAnalysis(existing.id, analysis)
    return existing
  }
  return insertImageOrGet({ contentHash: hash, format: file.format, byteSize: file.size, ...analysis })
}

// 对账：记录里有、磁盘上没有的文件。所在子目录读不了的不动；同一内容在别处还有正常位置的（被移动或改名了）删掉这条记录；其余标成“不见了”
async function reconcileMissing(rows: ScanFileRow[], present: Set<string>, unreadableDirs: string[]): Promise<void> {
  const gone = rows.filter(
    (r) => !present.has(pathKey(r.relPath)) && !unreadableDirs.some((d) => isWithin(d, r.relPath))
  )
  if (gone.length === 0) {
    return
  }
  const goneIds = gone.map((r) => r.id)
  const elsewhere = await findImagesWithOtherNormalFile(
    [...new Set(gone.map((r) => r.imageId))],
    goneIds
  )
  const moved = gone.filter((r) => elsewhere.has(r.imageId)).map((r) => r.id)
  const missing = gone.filter((r) => !elsewhere.has(r.imageId) && r.status !== 'MISSING').map((r) => r.id)
  await chunked(moved, softDeleteImageFiles)
  await chunked(missing, (ids) => updateImageFileStatus(ids, 'MISSING'))
  log.info(`对账：${moved.length} 条移到了别处，${missing.length} 条找不到`)
}

// 分批执行，避免一条 SQL 带太多参数
async function chunked(ids: number[], fn: (part: number[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    await fn(ids.slice(i, i + ID_CHUNK))
  }
}
