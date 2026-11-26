// 诺诺看图队列（设计 6.5）：新导入、还没打标签、过了本地分级闸门的非 R-18 图自动排队；
// 平时逐张实时看（并发 2、不自动重发推理请求），一次排进 50 张以上时超出的部分走批量推理（半价）。
// 结果存成 AI 建议，等你逐项确认
import {
  LOOK_KEY_HINT,
  SUGGESTION_REFRESH_DEEP_AT,
  SUGGESTION_REFRESH_MAX,
  type LookStateVO,
  type SuggestionRefreshStatusVO
} from '@shared/api'
import { AI_SETTING_KEYS, BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { bumpLibraryVersion } from '../../common/readCache'
import { isDatabaseOpen } from '../../db/client'
import { findActiveSettings, upsertSettings } from '../../repositories/appSettingRepository'
import {
  allowedLookImages,
  archiveReviewedLookFailures,
  cancelOpenLookJobs,
  completeLookJob,
  countSuggestionRefreshes,
  enqueueNewLookJobs,
  enqueueSuggestionRefresh,
  failLookBatch,
  findExistingLookContext,
  findLookBriefs,
  findLookInfo,
  findOpenLookJobs,
  findPendingIdentifyAttempt,
  insertLookJobs,
  lookBatchFileId,
  LOOK_CONTENT_REJECTED,
  markRejectedImageForReview,
  requeueLookJob,
  requeueRunningLookJobs,
  updateJob,
  type AiJobEntity
} from '../../repositories/aiResultRepository'
import { findTagNamesOf, findVocabulary } from '../../repositories/aiSearchRepository'
import { getVisualHintsForLook } from '../rating/ratingService'
import { searchCall } from './bailianClient'
import { localClues, type LocalClues } from './localClues'
import {
  BATCH_RETRY_MS,
  createLookBatchManager,
  type CloudLookError,
  type LookErrorClassification,
  type LookImageInfo,
  type LookVisualHints
} from './lookBatch'
import { LOOK_RULES, lookTail } from './lookPrompt'
import { prepareImage } from './imagePrep'
import { profileOfConversation } from './profileService'
import { keepToolSources } from './searchSources'
import { parseAssistJson as parseJsonBlock } from '@shared/assistJson'
import { normalizeFields, pendingStatus, type SuggestionFields } from './suggestion'

const log = getLogger('look')

// 实时看图的并发数、单张超时与自适应深度思考预算
const CONCURRENCY = 3
const TIMEOUT_MS = 120_000
const THINKING_BUDGET = 1024
const LOOK_PREFIX_IDLE_MS = 5 * 60_000
// 发给模型的图：实时长边缩到 1280，批量缩到 1024 控制文件体积
const LONG_EDGE = 1280
// 记在设置里的“从什么时候起导入的图自动看”（第一次启用看图时写入，之前的老图不自动排队，免得一次花掉很多钱）
const SINCE_KEY = AI_SETTING_KEYS.lookSince
// 状态里最多列多少行
const ROWS_MAX = 100

// 看图服务需要的外部信息
export interface LookConfig {
  thumbsDir: string
  tempDir: string
  // 现在能不能跑（扫描进行中返回 false）
  canRun: () => boolean
  // 队列变了：推给界面
  onState: (state: LookStateVO) => void
  // 有新建议了：界面刷新“AI 建议”计数
  onSuggested: () => void
  // 输入图片审核拦截后，刷新图库里的 R-18 标记及复核建议。
  onR18?: (count: number) => void
  // 后面还会不会有图排进来（本地分级还在跑）：会的话不满一批的补图先攒着
  moreLater?: () => boolean
}

let config: LookConfig | null = null
let since: Date | null = null
let active = 0
let stopping = false
let suspended = false
let shutdown: Promise<void> | null = null
const realtimeAbort = new AbortController()
let realtimePrefix: { value: Promise<string>; lastUse: number } | undefined
// 正在实时看的任务
const runningIds = new Set<number>()

const batch = createLookBatchManager({
  getConfig: () => config,
  isStopping: () => stopping,
  isSuspended: () => suspended,
  isCloudReady: cloudReady,
  isRealtimeRunning: (jobId) => runningIds.has(jobId),
  getAbortSignal: () => realtimeAbort.signal,
  pushState,
  scheduleLook,
  fillRealtime,
  imageDataUrl,
  cluesOf,
  loadCanonicalTags,
  saveLookResult,
  classifyError: lookError
})

// 配置看图服务（启动时调一次）
export function configureLook(next: LookConfig): void {
  config = next
}

// 有没有云端凭证
function cloudReady(): boolean {
  return !!readCloudCredentials().dashscopeApiKey
}

// 读或写“从什么时候起自动看”
async function lookSince(): Promise<Date> {
  if (since) {
    return since
  }
  const row = (await findActiveSettings()).find((s) => s.key === SINCE_KEY)
  const saved = typeof row?.value === 'string' ? new Date(row.value) : null
  if (saved && !Number.isNaN(saved.getTime())) {
    since = saved
  } else {
    since = new Date()
    await upsertSettings([{ key: SINCE_KEY, value: since.toISOString() }])
  }
  return since
}

// 当前队列状态（界面用）
export async function getLookState(): Promise<LookStateVO> {
  const jobs = await findOpenLookJobs()
  const shown = jobs.slice(0, ROWS_MAX)
  const briefs = await findLookBriefs(shown.map((j) => j.imageId).filter((id): id is number => id !== null))
  const rows = []
  for (const j of shown) {
    const info = j.imageId ? briefs.get(j.imageId) : undefined
    if (!info || !j.imageId) {
      continue
    }
    const batchId = j.remoteId ?? lookBatchFileId(j)
    rows.push({
      jobId: j.id,
      imageId: j.imageId,
      name: info.name,
      hash: info.hash,
      state: j.status === 'FAILED' ? ('FAILED' as const) : batchId ? ('BATCH' as const) : runningIds.has(j.id) ? ('RUNNING' as const) : ('QUEUED' as const),
      error: j.status === 'FAILED' ? (j.error ?? '出错了') : batchId && batch.isRetryingBatch(batchId) ? '正在重试查询' : null
    })
  }
  const canCancel = jobs.some((j) => (j.status === 'QUEUED' || j.status === 'FAILED') && !j.remoteId && !runningIds.has(j.id) && !batch.isPacking(j.id))
  // 队列预览只取前几行，底栏状态要包含后面的任务；网格/详情遮罩仅用于显式“重新识别/重新AI整理”任务且有密钥时。
  const hasCloudKey = cloudReady()
  const activeJobs = jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING')
  const overlayJobs = hasCloudKey
    ? activeJobs.filter((j) => {
        const p = j.payload as { refreshSuggestion?: boolean; reorganize?: boolean } | null
        return p?.refreshSuggestion === true || p?.reorganize === true
      })
    : []
  const activeImageIds = [...new Set(overlayJobs.map((j) => j.imageId).filter((id): id is number => id !== null))]
  const reorganizing = activeJobs.some((j) => (j.payload as { reorganize?: boolean } | null)?.reorganize === true)
  const working = jobs.some(j => j.status !== 'FAILED' && (runningIds.has(j.id) || batch.isPacking(j.id) || j.remoteId || lookBatchFileId(j)))
  const activity = working ? 'working' : jobs.some(j => j.status !== 'FAILED') ? 'queued' : 'idle'
  return { count: jobs.length, activity, rows, canCancel, needsApiKey: !hasCloudKey, reorganizing, activeImageIds }
}

// 密钥恢复后继续处理原队列，包括已经提交、等待查询结果的批次。
export async function onLookKeyChanged(): Promise<void> {
  if (!config || stopping || !isDatabaseOpen()) return
  await pushState()
  if (cloudReady()) {
    batch.schedulePoll(0)
    scheduleLook()
  }
}

// 推一次状态
async function pushState(): Promise<void> {
  if (stopping) return
  try {
    const current = await getLookState()
    if (!stopping) config?.onState(current)
  } catch (err) {
    log.error('读看图队列失败', err)
  }
}

export const pushLookState = pushState

// 启动：上次退出时没做完的放回排队，接着查批量任务，再排新图
export async function initLook(): Promise<void> {
  await archiveReviewedLookFailures()
  await requeueRunningLookJobs()
  await lookSince()
  batch.schedulePoll(10_000)
  await enqueueNewImages()
}

// 把符合条件的新图排进队列，然后开始看
export async function enqueueNewImages(): Promise<void> {
  if (!config || stopping) {
    return
  }
  const count = await enqueueNewLookJobs(await lookSince(), 1000)
  if (count > 0) {
    log.info(`看图队列：新排进 ${count} 张`)
  }
  await pushState()
  scheduleLook()
}

// 把图缩到指定长边、去掉元信息，转成 data URL；原图读不了（RAW、目录离线）时用缩略图
function imageDataUrl(info: LookImageInfo, longEdge = LONG_EDGE): Promise<string | null> {
  return prepareImage(info, config!.thumbsDir, longEdge)
}

function realtimeLookInstructions(): Promise<string> {
  const now = Date.now()
  if (!realtimePrefix || now - realtimePrefix.lastUse >= LOOK_PREFIX_IDLE_MS) {
    const value = profileOfConversation(null).then((profile) => `${LOOK_RULES}\n\n${profile}`)
    realtimePrefix = { value, lastUse: now }
    void value.catch(() => {
      if (realtimePrefix?.value === value) realtimePrefix = undefined
    })
  }
  realtimePrefix.lastUse = now
  return realtimePrefix.value
}

async function loadCanonicalTags(): Promise<Map<string, string>> {
  const vocab = await findVocabulary()
  const canonical = new Map<string, string>()
  for (const t of vocab) {
    for (const n of [t.name, ...t.aliases]) {
      canonical.set(n.toLowerCase(), t.name)
    }
  }
  return canonical
}

// 存下看图结果：整理成建议、描述直接补上（不覆盖已有的）
async function saveLookResult(
  jobId: number,
  imageId: number,
  content: unknown,
  clues: LocalClues,
  sources: string[] | null,
  model: string,
  usage: unknown,
  knownTags?: Map<string, string>,
  precomputed?: { existing?: string[]; fields?: SuggestionFields },
  supersedePendingIdentify = false
): Promise<boolean> {
  if (stopping) return false
  let fields: SuggestionFields
  if (precomputed?.fields) {
    fields = { ...precomputed.fields }
  } else {
    const raw = typeof content === 'string' ? parseJsonBlock(content) : null
    if (!raw) {
      await failLookBatch([jobId], '看图结果格式异常')
      return false
    }
    const canonical = knownTags ?? await loadCanonicalTags()
    const existing = precomputed?.existing ?? (await findTagNamesOf([imageId])).get(imageId) ?? []
    fields = normalizeFields(raw, { canonical, existing })
  }
  if (stopping) return false
  // 出处：文件名能确定的直接用；否则只要搜索工具返回过的链接（批量里没有搜索，只用文件名的）
  if (clues.source) {
    fields.source = clues.source
  } else if (fields.source && !(sources && keepToolSources([fields.source], sources.map((url) => ({ url }))).length > 0)) {
    fields.source = ''
  }
  if (!fields.character && clues.character) {
    fields.character = clues.character
  }
  const saved = await completeLookJob(
    jobId,
    { imageId, kind: 'IDENTIFY', origin: 'NONO', model, result: fields, fieldStatus: pendingStatus(fields), usage: usage ?? null },
    fields.description,
    supersedePendingIdentify
  )
  if (saved) {
    bumpLibraryVersion()
  }
  return saved
}

export function shouldEscalateThinking(
  raw: Record<string, unknown>,
  fields: SuggestionFields,
  clues: LocalClues,
  visualHints: LookVisualHints
): boolean {
  if (clues.photo) return false
  return raw.needs_thinking === true || (!fields.character && (visualHints?.characters?.length ?? 0) > 0)
}

// 一张图的线索
function cluesOf(info: LookImageInfo, visualHints: LookVisualHints = info.visualFeatures ?? null): LocalClues {
  const fileName = info.relPath?.split(/[/\\]/).pop() ?? ''
  return localClues(fileName, info.exif, { relPath: info.relPath, visualHints })
}

// 实时看一张
async function lookOne(job: AiJobEntity): Promise<void> {
  const info = job.imageId ? await findLookInfo(job.imageId) : undefined
  // 图没了、变成 R-18 了、没过上云闸门（本地还没判完）：不发给云端
  if (!info || !info.cloudAllowed) {
    await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
    return
  }
  const url = await imageDataUrl(info)
  if (!url) {
    await updateJob(job.id, { status: 'FAILED', error: '读不到原图', finishedAt: new Date() })
    return
  }
  const visualHints = Array.isArray(info.visualFeatures?.characters)
    ? info.visualFeatures
    : await getVisualHintsForLook(info.id)
  const clues = cluesOf(info, visualHints)
  const payload = (job.payload ?? null) as { reorganize?: boolean; refreshSuggestion?: boolean; forceThinking?: boolean } | null
  const isReorganize = payload?.reorganize === true
  const isRefreshSuggestion = payload?.refreshSuggestion === true
  const forceThinking = isRefreshSuggestion && payload?.forceThinking === true
  const existingContext = isReorganize ? await findExistingLookContext(info.id) : null
  const refreshAttempt = isRefreshSuggestion ? await findPendingIdentifyAttempt(info.id) : null
  const instructions = await realtimeLookInstructions()
  if (!(await allowedLookImages([info.id])).has(info.id)) {
    await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
    return
  }
  if (stopping) return
  const runPrimaryLook = (search: boolean) =>
    searchCall({
      kind: 'look',
      model: BAILIAN_CONFIG.chatModel,
      imageId: info.id,
      instructions,
      text: lookTail(clues, { existingContext, refreshAttempt }),
      imageDataUrl: url,
      search,
      enableThinking: forceThinking,
      ...(forceThinking ? { thinkingBudget: 2048 } : {}),
      timeoutMs: TIMEOUT_MS,
      signal: realtimeAbort.signal
    })
  const primarySearch = !clues.photo
  try {
    let res1: Awaited<ReturnType<typeof searchCall>>
    try {
      res1 = await runPrimaryLook(primarySearch)
    } catch (err) {
      if (!stopping && !realtimeAbort.signal.aborted && primarySearch && isRetryableLookTimeout(err)) {
        log.warn(`看图联网搜索超时，自动降级为纯视觉识别（图片 ${info.id}）`, err)
        res1 = await runPrimaryLook(false)
      } else {
        throw err
      }
    }
    if (stopping) return
    let finalText = res1.text
    let finalSources = res1.sources.map((s) => s.url)
    let finalUsage = res1.usage
    let canonical: Map<string, string> | undefined
    let existing: string[] | undefined
    let finalFields: SuggestionFields | undefined

    const raw1 = parseJsonBlock(res1.text)
    if (raw1) {
      const [loadedCanonical, existingMap] = await Promise.all([loadCanonicalTags(), findTagNamesOf([info.id])])
      canonical = loadedCanonical
      existing = existingMap.get(info.id) ?? []
      const preliminaryFields = normalizeFields(raw1, { canonical, existing })
      finalFields = preliminaryFields
      if (!forceThinking && shouldEscalateThinking(raw1, preliminaryFields, clues, visualHints) && !stopping) {
        try {
          const res2 = await searchCall({
            kind: 'look',
            model: BAILIAN_CONFIG.chatModel,
            imageId: info.id,
            instructions,
            text: lookTail(clues, { existingContext, refreshAttempt, thinkingRetry: true }),
            imageDataUrl: url,
            search: true,
            enableThinking: true,
            thinkingBudget: THINKING_BUDGET,
            timeoutMs: TIMEOUT_MS,
            signal: realtimeAbort.signal
          })
          if (stopping) return
          const raw2 = parseJsonBlock(res2.text)
          if (raw2) {
            finalText = res2.text
            finalSources = [...new Set([...finalSources, ...res2.sources.map((s) => s.url)])]
            finalUsage = res2.usage
            finalFields = normalizeFields(raw2, { canonical, existing })
          } else {
            log.warn(`看图二次深度核查结果格式异常，回退初次结果（图片 ${info.id}）`)
          }
        } catch (err) {
          if (stopping) return
          log.warn(`看图二次深度核查失败，回退初次结果（图片 ${info.id}）`, err)
        }
      }
    }

    if (
      await saveLookResult(
        job.id,
        info.id,
        finalText,
        clues,
        finalSources,
        BAILIAN_CONFIG.chatModel,
        finalUsage,
        canonical,
        canonical ? { existing, fields: finalFields } : undefined,
        isRefreshSuggestion || isReorganize
      )
    ) {
      config?.onSuggested()
    }
  } catch (err) {
    if (stopping) return
    log.warn(`看图失败（图片 ${info.id}）`, err)
    const failure = lookError(err)
    if (failure.inputImageRejected) {
      if (await markRejectedImageForReview(job.id, BAILIAN_CONFIG.chatModel)) {
        bumpLibraryVersion()
        config?.onR18?.(1)
      }
    } else {
      await updateJob(job.id, { status: 'FAILED', error: failure.message, finishedAt: new Date() })
    }
  }
}

function isRetryableLookTimeout(err: unknown): boolean {
  const failure = err as (CloudLookError & { error?: CloudLookError }) | null
  if (failure?.status === 401 || failure?.status === 403 || failure?.status === 429) return false
  const classified = lookError(err)
  return !classified.inputImageRejected && (classified.message === '超时' || classified.message === '网络异常')
}

function lookError(err: unknown): LookErrorClassification {
  const failure = err as (CloudLookError & { error?: CloudLookError }) | null
  const message = `${failure?.message ?? ''} ${failure?.error?.message ?? ''}`
  const details = `${failure?.code ?? ''} ${failure?.type ?? ''} ${failure?.error?.code ?? ''} ${failure?.error?.type ?? ''} ${message} ${failure?.name ?? ''}`
  const explicitImage = /\binput\s+(?:image|picture)\b|输入(?:的)?(?:图像|图片)/i.test(message)
  const moderation = /data[_ ]?inspection[_ ]?failed|content[_ ]?filter/i.test(details) ||
    (explicitImage && /inappropriate content|rejected.{0,60}before model inference|内容审核/i.test(message))
  if (moderation) {
    // 输出被拦截或未指明是哪部分输入有问题时，保留原分级。
    return explicitImage
      ? { message: LOOK_CONTENT_REJECTED, inputImageRejected: true }
      : { message: LOOK_CONTENT_REJECTED }
  }
  if (/timed? ?out|timeout|超时/i.test(details) || failure?.status === 408) return { message: '超时' }
  if (failure?.status === 429) return { message: '云端限流' }
  return { message: failure?.status ? `云端请求失败（${failure.status}）` : '网络异常' }
}

// 开始干活：两个并发逐张实时看（马上就有结果），同时把超出 50 张的部分打成批量
export function scheduleLook(): void {
  if (!config || stopping || suspended || !cloudReady()) {
    return
  }
  void fillRealtime().catch((err: unknown) => log.error('看图队列出错', err))
  batch.scheduleSubmission()
}

// 实时看的空位填满
async function fillRealtime(): Promise<void> {
  while (active < CONCURRENCY) {
    if (!(await pumpOne())) {
      break
    }
  }
}

// 取下一张实时看；没有可做的返回 false
async function pumpOne(): Promise<boolean> {
  if (stopping || suspended || !config!.canRun()) {
    return false
  }
  // 补图（优先级为负）只走批量，不在这里实时看；正在打包交批量的也不碰
  const pick = (j: AiJobEntity): boolean => j.status === 'QUEUED' && !j.remoteId && !runningIds.has(j.id) && !batch.isPacking(j.id) && j.priority >= 0
  const next = (await findOpenLookJobs()).find(pick)
  // 查库期间别的地方可能已经拿走了它或占满了空位
  if (stopping || suspended || !next || !pick(next) || active >= CONCURRENCY) {
    return false
  }
  active++
  runningIds.add(next.id)
  try {
    await updateJob(next.id, { status: 'RUNNING', startedAt: new Date(), attempts: next.attempts + 1 })
  } catch (err) {
    active--
    runningIds.delete(next.id)
    throw err
  }
  await pushState()
  void lookOne(next)
    .catch(async (err: unknown) => {
      if (stopping) return
      log.error('本地处理看图任务失败', err)
      await updateJob(next.id, { status: 'FAILED', error: '本地处理失败', finishedAt: new Date() })
    })
    .finally(async () => {
      active--
      runningIds.delete(next.id)
      await pushState()
      scheduleLook()
    }).catch((err: unknown) => log.error('更新看图任务失败', err))
  return true
}

// 重试一张出错的
export async function retryLook(jobId: number): Promise<void> {
  await requeueLookJob(jobId)
  await pushState()
  scheduleLook()
}

// 让某张图现在就看：排到最前面（已经在队列里就提优先级）
export async function lookNow(imageId: number): Promise<void> {
  const open = (await findOpenLookJobs()).find((j) => j.imageId === imageId)
  if (open) {
    if (!batch.isPacking(open.id)) {
      await requeueLookJob(open.id, 10)
    }
  } else {
    const info = await findLookInfo(imageId)
    if (!info) {
      throw new BizError('NOT_FOUND', '这张图已经不在图库里了')
    }
    if (info.isR18) {
      throw new BizError('CONFLICT', 'R-18 图不发给云端')
    }
    if (!info.cloudAllowed) {
      throw new BizError('CONFLICT', '本地分级还没判完这张，判完再看')
    }
    await insertLookJobs([imageId], 10)
  }
  await pushState()
  scheduleLook()
}

// 全部取消：排队中和出错的都取消（已经发出去的几张做完为止）
export async function cancelAllLooks(): Promise<number> {
  const n = await cancelOpenLookJobs([...runningIds, ...batch.getPackingIds()])
  await pushState()
  return n
}

export async function getSuggestionRefreshStatus(imageId: number): Promise<SuggestionRefreshStatusVO> {
  if (!Number.isInteger(imageId) || imageId <= 0) {
    throw new BizError('BAD_REQUEST', 'id 不对')
  }
  const [refreshCount, open] = await Promise.all([countSuggestionRefreshes(imageId), findOpenLookJobs()])
  const isActive = open.some((j) => j.imageId === imageId && (j.status === 'QUEUED' || j.status === 'RUNNING'))
  return { refreshCount, maxRefreshes: SUGGESTION_REFRESH_MAX, active: isActive }
}

export async function refreshSuggestion(imageId: number): Promise<SuggestionRefreshStatusVO> {
  if (!Number.isInteger(imageId) || imageId <= 0) {
    throw new BizError('BAD_REQUEST', 'id 不对')
  }
  if (!cloudReady()) {
    throw new BizError('DEPENDENCY_FAILED', LOOK_KEY_HINT)
  }
  const info = await findLookInfo(imageId)
  if (!info) {
    throw new BizError('NOT_FOUND', '这张图已经不在图库里了')
  }
  if (info.isR18) {
    throw new BizError('CONFLICT', 'R-18 图不发给云端')
  }
  if (!info.cloudAllowed) {
    throw new BizError('CONFLICT', '本地分级还没判完这张，判完再看')
  }
  const open = await findOpenLookJobs()
  if (open.some((j) => j.imageId === imageId && (j.status === 'QUEUED' || j.status === 'RUNNING'))) {
    throw new BizError('CONFLICT', '这张图正在队列中，请稍候')
  }
  const used = await countSuggestionRefreshes(imageId)
  if (used >= SUGGESTION_REFRESH_MAX) {
    throw new BizError('CONFLICT', `每张图最多重新识别 ${SUGGESTION_REFRESH_MAX} 次`)
  }
  const refreshRound = used + 1
  const forceThinking = refreshRound >= SUGGESTION_REFRESH_DEEP_AT
  const enqueued = await enqueueSuggestionRefresh(imageId, refreshRound, forceThinking)
  if (!enqueued) {
    throw new BizError('CONFLICT', '这张图正在队列中，请稍候')
  }
  await pushState()
  scheduleLook()
  return getSuggestionRefreshStatus(imageId)
}

// 云端批次需要用提交时的账号查询和取消。保存新密钥期间暂停提交，避免检查后又产生旧账号的批次。
export function changeLookBatchKey<T>(save: () => Promise<T>): Promise<T> {
  return batch.changeBatchKey(save)
}

// 系统休眠时暂停轮询与新任务调度，不破坏进行中的状态
export function pauseLookForSuspend(): void {
  suspended = true
  batch.clearPollTimer()
}

// 系统唤醒后恢复看图队列与批量轮询
export function resumeLookAfterSuspend(): void {
  suspended = false
  scheduleLook()
  if (config && !stopping && cloudReady()) {
    batch.schedulePoll(BATCH_RETRY_MS)
  }
}

// 是不是正在实时看图（做梦时看忙不忙）
export function isLookBusy(): boolean {
  return active > 0
}

// 退出先中断本机看图并停止提交，再撤销仍在云端处理的批次。
export function stopLook(): Promise<void> {
  if (shutdown) return shutdown
  stopping = true
  realtimeAbort.abort()
  batch.clearPollTimer()
  shutdown = batch.cancelOnExit()
  return shutdown
}
