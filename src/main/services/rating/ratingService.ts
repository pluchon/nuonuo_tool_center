// 本地分级：扫描完、启动后在后台给还没分级的图逐张判一遍（WD 模型，跑在单独的 utilityProcess 里）。
// 判为明显 R-18 的直接打上（诺诺判的）；手动开关过的图永远不改。扫描进行中让路，空闲一段时间后关掉工作进程释放内存
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { utilityProcess, type UtilityProcess } from 'electron'
import { getLogger } from '../../common/logger'
import { bumpLibraryVersion } from '../../common/readCache'
import type { RatingProgressVO } from '@shared/api'
import { getDatabase } from '../../db/client'
import { image } from '../../db/schema'
import { countRatingCandidates, findRatingCandidates, saveModelRating } from '../../repositories/imageRepository'
import { findSearchVisualFeatures, saveSearchVisualFeatures } from '../../repositories/aiSearchRepository'
import { WD_GENERAL_THRESHOLD, type RatingRequest, type RatingResponse, type WdCharacterHint } from './ratingProtocol'
import { loadCheckpoint, RATING_CHECKPOINT, saveCheckpoint } from '../progressCheckpoint'
import { pickModelFile } from './modelFile'
import { ensureModel, isModelReady, MODEL_NAME, modelDirOf } from './modelStore'
import type { WdRating } from './wdTagger'

const log = getLogger('rating')

// 每次从库里取多少张
const BATCH = 20
// 单张最多等多久（第一张要加载模型，给得宽一些）
const PER_IMAGE_TIMEOUT_MS = 120_000
// 空闲多久关掉工作进程（模型常驻约 0.8 GB）
const IDLE_EXIT_MS = 2 * 60_000
// 更换模型或通用标签阈值时更新版本，旧缓存按查询逐张重建。
export const FEATURE_REVISION = `${MODEL_NAME}:general-${WD_GENERAL_THRESHOLD}-v1`
// 明显 R-18 的口径：questionable + explicit ≥ 0.5（用户确认过的阈值）
export const R18_THRESHOLD = 0.5
// 推理线程：你在用这个软件时 3 个；插着电且软件不在前台或电脑 1 分钟没人操作时 4 个（int8 实测 2/3/4 线程一张约 0.54/0.44/0.39 秒，再多几乎不快了）
export const THREADS_ACTIVE = 3
export const THREADS_IDLE = 4
// 换到更多线程前至少等多久（换线程要重新加载模型约 3 秒，免得来回切）；换回少线程是立即的
const RAISE_AFTER_MS = 60_000

// 分级服务需要的外部信息
export interface RatingConfig {
  modelsRoot: string
  thumbsDir: string
  workerPath: string
  // 现在能不能跑（扫描进行中返回 false）
  canRun: () => boolean
  // 这一轮有图被判成 R-18：通知界面刷新
  onR18: (count: number) => void
  // 明显 R-18 的阈值（正常就是 R18_THRESHOLD）
  threshold: number
  // 一轮判完（新图过了上云闸门，可以排进看图队列了）
  onDone: () => void
  // 进度变了：推给界面（底栏“本地分级中…”）
  onProgress?: (p: RatingProgressVO) => void
  // 能不能多用线程（插着电，且软件不在前台或系统空闲 1 分钟以上）；不给时一直按有人在用
  machineIdle?: () => boolean
  // 每判完一小批（约 20 张）：新判完的图可以接着排看图、补进一键整理，不用等整轮判完
  onBatch?: () => void
}

// 你正在看的图：插到最前面先判（最多记这么多张）
const URGENT_MAX = 50
let urgent: number[] = []

// 让这张图先判（详情面板打开一张还没分级的图时）；没在跑就开始一轮
export async function prioritizeRating(imageId: number): Promise<void> {
  if (!Number.isInteger(imageId) || urgent.includes(imageId) || (await findRatingCandidates(1, [imageId])).length === 0) {
    return
  }
  urgent = [imageId, ...urgent].slice(0, URGENT_MAX)
  scheduleRating()
}

// 当前用的线程数和上次切换的时间
let threads = THREADS_ACTIVE
let switchedAt = 0

// 这一张用几个线程：你在用就立刻回到 3 个；不用了要稳定一会儿才加到 4 个
export function pickThreads(idle: boolean, current: number, sinceSwitchMs: number): number {
  if (!idle) {
    return THREADS_ACTIVE
  }
  return current < THREADS_IDLE && sinceSwitchMs < RAISE_AFTER_MS ? current : THREADS_IDLE
}

// 按电脑现在忙不忙定线程数
function threadsNow(): number {
  const next = pickThreads(config?.machineIdle?.() ?? false, threads, Date.now() - switchedAt)
  if (next !== threads) {
    threads = next
    switchedAt = Date.now()
  }
  return threads
}

// 当前进度（这一轮）
let progress: RatingProgressVO = { running: false, done: 0, total: 0 }

// 改进度并推给界面
function setProgress(next: RatingProgressVO): void {
  progress = next
  config?.onProgress?.(next)
}

// 当前进度（界面打开时读一次）
export function getRatingProgress(): RatingProgressVO {
  return progress
}

let config: RatingConfig | null = null
let worker: UtilityProcess | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
let stopping = false
const shutdown = new AbortController()
let seq = 0
const waiters = new Map<number, (r: RatingResponse) => void>()
let workerQueue: Promise<void> = Promise.resolve()
const pendingFeatures = new Map<number, Promise<string[] | null>>()
const CRASH_BACKOFFS_MS = [1000, 3000, 8000]
let consecutiveCrashes = 0
let workerDegraded = false
let nextSpawnAllowedAt = 0

// 计算连续崩溃后的退避延迟（第 1/2/3 次分别等 1s/3s/8s；超过 3 次返回 null 表示进入降级模式）
export function nextCrashBackoffMs(consecutiveCrashes: number): number | null {
  if (consecutiveCrashes <= 0) return 0
  return CRASH_BACKOFFS_MS[consecutiveCrashes - 1] ?? null
}

// 恢复系统唤醒或重新配置后重置工作进程降级标记
export function resetRatingDegradation(): void {
  consecutiveCrashes = 0
  workerDegraded = false
  nextSpawnAllowedAt = 0
}

// 配置分级服务（启动时调一次）
export function configureRating(next: RatingConfig): void {
  config = next
  resetRatingDegradation()
}

// WD 的四个分数换成库里的分级枚举：取最高的那个
export function ratingOf(scores: Record<WdRating, number>): 'GENERAL' | 'SENSITIVE' | 'QUESTIONABLE' | 'EXPLICIT' {
  const order: WdRating[] = ['general', 'sensitive', 'questionable', 'explicit']
  const top = order.reduce((a, b) => (scores[b] > scores[a] ? b : a))
  return top.toUpperCase() as 'GENERAL' | 'SENSITIVE' | 'QUESTIONABLE' | 'EXPLICIT'
}

// 是不是明显 R-18
export function isObviousR18(scores: Record<WdRating, number>, threshold: number = R18_THRESHOLD): boolean {
  return scores.questionable + scores.explicit >= threshold
}

// 测试用的阈值（LTM_R18_THRESHOLD）：只能往下调（判得更严、多打 R-18），往上调一律无效，免得放松上云闸门
export function thresholdFromEnv(raw: string | undefined): number {
  const v = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(v) && v >= 0 ? Math.min(v, R18_THRESHOLD) : R18_THRESHOLD
}

// 起工作进程（已在跑就复用）
function ensureWorker(): UtilityProcess {
  if (worker) {
    return worker
  }
  const child = utilityProcess.fork(config!.workerPath, [], { serviceName: '诺诺本地分级', stdio: 'ignore' })
  child.on('message', (msg: RatingResponse) => {
    if (msg.ok) {
      consecutiveCrashes = 0
      workerDegraded = false
      nextSpawnAllowedAt = 0
    }
    const done = waiters.get(msg.id)
    if (done) {
      waiters.delete(msg.id)
      done(msg)
    }
  })
  child.on('exit', (code) => {
    if (worker !== child) return
    worker = null
    const hadPendingWaiters = waiters.size > 0
    // 进程没了：还在等的都按失败处理
    for (const [id, done] of waiters) {
      done({ id, ok: false, error: `工作进程退出（${code}）` })
    }
    waiters.clear()
    if (!stopping && (code !== 0 || hadPendingWaiters)) {
      consecutiveCrashes += 1
      const backoff = nextCrashBackoffMs(consecutiveCrashes)
      if (backoff === null) {
        workerDegraded = true
        log.error('本地分级工作进程连续异常退出，已暂时降级跳过，避免持续重启占满 CPU')
      } else {
        nextSpawnAllowedAt = Date.now() + backoff
        log.warn(`本地分级工作进程异常退出（code=${code}，第 ${consecutiveCrashes} 次），${backoff}ms 后重试`)
      }
    }
  })
  worker = child
  return child
}

// 关掉工作进程
function killWorker(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  worker?.kill()
  worker = null
  for (const [id, done] of waiters) done({ id, ok: false, error: '工作进程已关闭' })
  waiters.clear()
}

// 发一张给工作进程，等结果或超时
async function inferFile(file: string, modelDir: string, threadCount: number): Promise<RatingResponse> {
  const id = ++seq
  if (workerDegraded) {
    return { id, ok: false, error: '本地分级工作进程异常降级' }
  }
  if (!worker && nextSpawnAllowedAt > Date.now()) {
    const waitMs = nextSpawnAllowedAt - Date.now()
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        shutdown.signal.removeEventListener('abort', onAbort)
        resolve()
      }, waitMs)
      shutdown.signal.addEventListener('abort', onAbort, { once: true })
    })
    if (stopping) return { id, ok: false, error: '正在退出' }
    if (workerDegraded) return { id, ok: false, error: '本地分级工作进程异常降级' }
  }
  const child = ensureWorker()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      killWorker()
      resolve({ id, ok: false, error: '超时' })
    }, PER_IMAGE_TIMEOUT_MS)
    waiters.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    const req: RatingRequest = { id, file, modelDir, threads: threadCount }
    try {
      child.postMessage(req)
    } catch {
      clearTimeout(timer)
      waiters.delete(id)
      resolve({ id, ok: false, error: '工作进程无法接收请求' })
    }
  })
}

// 分级、上传和搜索共用一个工作进程，线程数调整必须等当前推理完成。
function rateFile(file: string, modelDir: string, threadCount: number): Promise<RatingResponse> {
  const request = workerQueue.then(async (): Promise<RatingResponse> => {
    if (stopping) return { id: 0, ok: false, error: '正在退出' }
    if (idleTimer) clearTimeout(idleTimer)
    try {
      return await inferFile(file, modelDir, threadCount)
    } finally {
      if (!stopping) idleTimer = setTimeout(killWorker, IDLE_EXIT_MS)
    }
  })
  workerQueue = request.then(() => undefined, () => undefined)
  return request
}

// 只为本轮普通图片候选补充特征。并发搜索共享推理，缺少本地模型时保留未知状态。
export function getVisualTagsForSearch(imageId: number): Promise<string[] | null> {
  const pending = pendingFeatures.get(imageId)
  if (pending) return pending
  if (stopping) return Promise.resolve(null)
  const request = (async () => {
    const row = await findSearchVisualFeatures(imageId)
    if (!row) return null
    const cached = row.features
    if (cached?.revision === FEATURE_REVISION && Array.isArray(cached.tags) && cached.tags.every((tag) => typeof tag === 'string')) return cached.tags
    const cfg = config
    if (!cfg || !(await isModelReady(cfg.modelsRoot))) return null
    const res = await rateFile(join(cfg.thumbsDir, row.contentHash + '.webp'), modelDirOf(cfg.modelsRoot), threads)
    if (!res.ok || stopping) return null
    return await saveSearchVisualFeatures(imageId, FEATURE_REVISION, res.tags, res.characters) ? res.tags : null
  })().catch((error: unknown) => {
    log.warn(`图片 ${imageId} 无法校验本地画面特征`, error)
    return null
  }).finally(() => pendingFeatures.delete(imageId))
  pendingFeatures.set(imageId, request)
  return request
}

// 为看图提取本地 WD 角色与画面特征线索（只读普通图，不抛错，模型不可用时降级返回已有特征或 null）
export async function getVisualHintsForLook(
  imageId: number
): Promise<{ tags: string[]; characters: WdCharacterHint[] } | null> {
  let fallback: { tags: string[]; characters: WdCharacterHint[] } | null = null
  try {
    const { db } = getDatabase()
    const [row] = await db
      .select({ contentHash: image.contentHash, visualFeatures: image.visualFeatures })
      .from(image)
      .where(and(eq(image.id, imageId), eq(image.deleteState, 0), eq(image.isR18, false)))
      .limit(1)
    if (!row) return null

    const cached = row.visualFeatures
    const cachedTags = Array.isArray(cached?.tags)
      ? cached.tags.filter((tag): tag is string => typeof tag === 'string')
      : null
    if (Array.isArray(cached?.characters)) {
      return { tags: cachedTags ?? [], characters: cached.characters }
    }
    if (cachedTags) {
      fallback = { tags: cachedTags, characters: [] }
    }

    const cfg = config
    if (!cfg || stopping || !(await isModelReady(cfg.modelsRoot))) {
      return fallback
    }
    const res = await rateFile(join(cfg.thumbsDir, `${row.contentHash}.webp`), modelDirOf(cfg.modelsRoot), threads)
    if (!res.ok || stopping) {
      return fallback
    }
    if (isObviousR18(res.scores, cfg.threshold)) {
      return null
    }
    const characters = res.characters ?? []
    const nextFeatures = { revision: FEATURE_REVISION, tags: res.tags, characters }
    await db
      .update(image)
      .set({ visualFeatures: nextFeatures })
      .where(and(eq(image.id, imageId), eq(image.deleteState, 0), eq(image.isR18, false)))
    return { tags: res.tags, characters }
  } catch (error: unknown) {
    log.warn(`图片 ${imageId} 无法提取本地角色与画面特征`, error)
    return fallback
  }
}

// 跑一轮：一批一批取还没分级的图，直到没有了、扫描开始了或要退出了
async function runOnce(): Promise<void> {
  const cfg = config!
  const modelDir = modelDirOf(cfg.modelsRoot)
  // 上次退出（或被扫描打断）时这一轮已经判了几张：接着算，进度从“200/3000”继续而不是“0/2800”
  const base = (await loadCheckpoint<{ done: number }>(RATING_CHECKPOINT))?.done ?? 0
  let rated = 0
  let r18 = 0
  let finished = false
  for (;;) {
    if (stopping || workerDegraded || !cfg.canRun()) {
      break
    }
    // 先判你正在看的，再按最新导入的往前判
    const wanted = urgent
    urgent = []
    const first = await findRatingCandidates(BATCH, wanted)
    const batch = first.length > 0 ? first : await findRatingCandidates(BATCH)
    if (batch.length === 0) {
      finished = true
      break
    }
    if (rated === 0) {
      if (!(await ensureModel(cfg.modelsRoot, shutdown.signal))) {
        if (!stopping) log.warn('本地分级模型不可用，这次跳过')
        return
      }
      log.info(`本地分级用 ${pickModelFile(modelDir)}`)
    }
    // 中途又导入了新图时分母跟着变大
    setProgress({ running: true, done: base + rated, total: base + rated + (await countRatingCandidates()) })
    for (const img of batch) {
      if (stopping || workerDegraded || !cfg.canRun()) {
        break
      }
      const res = await rateFile(join(cfg.thumbsDir, `${img.contentHash}.webp`), modelDir, threadsNow())
      if (stopping && !res.ok) break
      if (res.ok) {
        const hit = isObviousR18(res.scores, cfg.threshold)
        const features = hit
          ? undefined
          : { revision: FEATURE_REVISION, tags: res.tags, ...(res.characters?.length ? { characters: res.characters } : {}) }
        if (await saveModelRating(img.id, ratingOf(res.scores), res.scores, hit, features)) {
          bumpLibraryVersion()
          if (hit) r18++
        }
      } else if (workerDegraded) {
        log.warn(`图片 ${img.id} 因本地分级工作进程降级暂停处理：${res.error}`)
        break
      } else {
        // 判不了的（缩略图读不出来、超时）记成 UNKNOWN，不反复重试
        log.warn(`图片 ${img.id} 分级失败：${res.error}`)
        await saveModelRating(img.id, 'UNKNOWN', { error: res.error }, false)
      }
      rated++
      setProgress({ running: true, done: base + rated, total: Math.max(progress.total, base + rated) })
    }
    // 每判完一小批记一次断点（突然断电也最多丢一小批的进度）
    await saveCheckpoint(RATING_CHECKPOINT, { done: base + rated })
    cfg.onBatch?.()
  }
  // 全判完了清掉断点；被退出或扫描打断的留着，下一轮接着数
  await saveCheckpoint(RATING_CHECKPOINT, finished ? null : { done: base + rated })
  setProgress({ running: false, done: base + rated, total: base + rated })
  if (rated > 0) {
    log.info(`本地分级：判了 ${rated} 张，其中 ${r18} 张判为 R-18`)
  }
  if (r18 > 0) {
    cfg.onR18(r18)
  }
  cfg.onDone()
}

// 有新图或扫描结束后调用：没在跑就开始一轮；跑完一段时间没新活就关掉工作进程
export function scheduleRating(): void {
  if (!config || running || stopping || workerDegraded) {
    return
  }
  running = runOnce()
    .catch((err: unknown) => log.error('本地分级出错', err))
    .finally(() => {
      running = null
      if (progress.running) {
        setProgress({ ...progress, running: false })
      }
    })
}

// 现在就给一个文件分级（诺诺助手里上传的图，上云前过本地闸门）；模型不可用时返回 null
export async function rateFileNow(file: string): Promise<{ scores: Record<WdRating, number>; r18: boolean } | null> {
  const cfg = config
  if (!cfg || stopping || !(await ensureModel(cfg.modelsRoot, shutdown.signal))) {
    return null
  }
  // 你在等结果：用当前已加载的线程数，不为一张图重新加载模型
  const res = await rateFile(file, modelDirOf(cfg.modelsRoot), threads)
  return res.ok ? { scores: res.scores, r18: isObviousR18(res.scores, cfg.threshold) } : null
}

// 本地分级是不是正在跑（做梦时看忙不忙）
export function isRatingBusy(): boolean {
  return running !== null
}

// 退出时取消下载和推理。未完成的图片保留为待分级，下次启动继续。
export async function stopRating(): Promise<void> {
  stopping = true
  shutdown.abort()
  killWorker()
  await Promise.allSettled([running, workerQueue, ...pendingFeatures.values()])
}
