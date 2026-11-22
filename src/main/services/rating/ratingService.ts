// 本地分级：扫描完、启动后在后台给还没分级的图逐张判一遍（WD 模型，跑在单独的 utilityProcess 里）。
// 判为明显 R-18 的直接打上（诺诺判的）；手动开关过的图永远不改。扫描进行中让路，空闲一段时间后关掉工作进程释放内存
import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { getLogger } from '../../common/logger'
import { findRatingCandidates, saveModelRating } from '../../repositories/imageRepository'
import type { RatingRequest, RatingResponse } from './ratingProtocol'
import { ensureModel, modelDirOf } from './modelStore'
import type { WdRating } from './wdTagger'

const log = getLogger('rating')

// 每次从库里取多少张
const BATCH = 20
// 单张最多等多久（第一张要加载模型，给得宽一些）
const PER_IMAGE_TIMEOUT_MS = 120_000
// 空闲多久关掉工作进程（模型常驻约 0.8 GB）
const IDLE_EXIT_MS = 2 * 60_000
// 明显 R-18 的口径：questionable + explicit ≥ 0.5（用户确认过的阈值）
export const R18_THRESHOLD = 0.5

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
}

let config: RatingConfig | null = null
let worker: UtilityProcess | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
let stopping = false
let seq = 0
const waiters = new Map<number, (r: RatingResponse) => void>()

// 配置分级服务（启动时调一次）
export function configureRating(next: RatingConfig): void {
  config = next
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
    const done = waiters.get(msg.id)
    if (done) {
      waiters.delete(msg.id)
      done(msg)
    }
  })
  child.on('exit', (code) => {
    if (worker === child) {
      worker = null
    }
    // 进程没了：还在等的都按失败处理
    for (const [id, done] of waiters) {
      done({ id, ok: false, error: `工作进程退出（${code}）` })
    }
    waiters.clear()
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
}

// 发一张给工作进程，等结果或超时
function rateFile(file: string, modelDir: string): Promise<RatingResponse> {
  const id = ++seq
  const child = ensureWorker()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      resolve({ id, ok: false, error: '超时' })
    }, PER_IMAGE_TIMEOUT_MS)
    waiters.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    const req: RatingRequest = { id, file, modelDir }
    child.postMessage(req)
  })
}

// 跑一轮：一批一批取还没分级的图，直到没有了、扫描开始了或要退出了
async function runOnce(): Promise<void> {
  const cfg = config!
  if (!(await ensureModel(cfg.modelsRoot))) {
    log.warn('本地分级模型不可用，这次跳过')
    return
  }
  const modelDir = modelDirOf(cfg.modelsRoot)
  let rated = 0
  let r18 = 0
  for (;;) {
    if (stopping || !cfg.canRun()) {
      break
    }
    const batch = await findRatingCandidates(BATCH)
    if (batch.length === 0) {
      break
    }
    for (const img of batch) {
      if (stopping || !cfg.canRun()) {
        break
      }
      const res = await rateFile(join(cfg.thumbsDir, `${img.contentHash}.webp`), modelDir)
      if (res.ok) {
        const hit = isObviousR18(res.scores, cfg.threshold)
        if ((await saveModelRating(img.id, ratingOf(res.scores), res.scores, hit)) && hit) {
          r18++
        }
      } else {
        // 判不了的（缩略图读不出来、超时）记成 UNKNOWN，不反复重试
        log.warn(`图片 ${img.id} 分级失败：${res.error}`)
        await saveModelRating(img.id, 'UNKNOWN', { error: res.error }, false)
      }
      rated++
    }
  }
  if (rated > 0) {
    log.info(`本地分级：判了 ${rated} 张，其中 ${r18} 张判为 R-18`)
  }
  if (r18 > 0) {
    cfg.onR18(r18)
  }
}

// 有新图或扫描结束后调用：没在跑就开始一轮；跑完一段时间没新活就关掉工作进程
export function scheduleRating(): void {
  if (!config || running || stopping) {
    return
  }
  running = runOnce()
    .catch((err: unknown) => log.error('本地分级出错', err))
    .finally(() => {
      running = null
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      idleTimer = setTimeout(killWorker, IDLE_EXIT_MS)
    })
}

// 退出前：不再开始新的一张，等手上这张做完，关掉工作进程
export async function stopRating(): Promise<void> {
  stopping = true
  await running
  killWorker()
}
