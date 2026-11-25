// 诺诺看图队列（设计 6.5）：新导入、还没打标签、过了本地分级闸门的非 R-18 图自动排队；
// 平时逐张实时看（并发 2、不自动重发推理请求），一次排进 50 张以上时超出的部分走批量推理（半价）。
// 结果存成 AI 建议，等你逐项确认
import { createReadStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LookStateVO } from '@shared/api'
import { BAILIAN_CONFIG, ORGANIZE_COST, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { isDatabaseOpen } from '../../db/client'
import { findActiveSettings, upsertSettings } from '../../repositories/appSettingRepository'
import {
  allowedLookImages,
  archiveReviewedLookFailures,
  attachLookBatch,
  cancelOpenLookJobs,
  completeLookJob,
  enqueueNewLookJobs,
  failLookBatch,
  findExistingLookContext,
  findLookBriefs,
  findLookInfo,
  findOpenLookJobs,
  insertLookJobs,
  lookBatchFileId,
  LOOK_BACKLOG_PRIORITY,
  LOOK_BATCH_PRIORITY,
  LOOK_CONTENT_REJECTED,
  markRejectedImageForReview,
  pauseLookBatch,
  preferBatchForLookJobs,
  rememberLookBatch,
  requeueLookJob,
  requeuePausedLookBatch,
  requeueRunningLookJobs,
  resumesAfterLookCancel,
  updateJob,
  type AiJobEntity
} from '../../repositories/aiResultRepository'
import { findTagNamesOf, findVocabulary } from '../../repositories/aiSearchRepository'
import { getVisualHintsForLook } from '../rating/ratingService'
import { getBailianClient, recordBatchUsage, searchCall } from './bailianClient'
import { localClues, type LocalClues } from './localClues'
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
// 队列里超过这么多张时，超出的部分走批量推理
const BATCH_OVER = ORGANIZE_COST.realtimeMax
const LOOK_PREFIX_IDLE_MS = 5 * 60_000
// 一个批次最多几张（每张图 base64 后几百 KB，批次文件不宜太大）
const BATCH_SIZE = 100
// 多久查一次批量任务
const BATCH_POLL_MS = 60_000
const BATCH_RETRY_MS = 15_000
const BATCH_READ_TIMEOUT_MS = 20_000
const BATCH_CANCEL_TIMEOUT_MS = 10_000
const BATCH_CONFIRM_WINDOW_MS = 5 * 60_000
// 发给模型的图：实时长边缩到 1280，批量缩到 1024 控制文件体积
const LONG_EDGE = 1280
const BATCH_LONG_EDGE = 1024
// 记在设置里的“从什么时候起导入的图自动看”（第一次启用看图时写入，之前的老图不自动排队，免得一次花掉很多钱）
const SINCE_KEY = 'ai.lookSince'
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
let pollTimer: ReturnType<typeof setTimeout> | null = null
let polling = false
let batchRegistration: Promise<void> | null = null
let shutdown: Promise<void> | null = null
const realtimeAbort = new AbortController()
const retryingBatches = new Set<string>()
let realtimePrefix: { value: Promise<string>; lastUse: number } | undefined
// 正在实时看的任务
const runningIds = new Set<number>()
// 正在打包交批量的任务（实时那边不碰）
const packingIds = new Set<number>()
// 交批量同一时间只跑一路；跑着时又被叫到，跑完再来一轮（免得两路把同一批图各交一次）
let submitting = false
let submitAgain = false
let changingBailianKey = false

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
    const batch = j.remoteId ?? lookBatchFileId(j)
    rows.push({
      jobId: j.id,
      imageId: j.imageId,
      name: info.name,
      hash: info.hash,
      state: j.status === 'FAILED' ? ('FAILED' as const) : batch ? ('BATCH' as const) : runningIds.has(j.id) ? ('RUNNING' as const) : ('QUEUED' as const),
      error: j.status === 'FAILED' ? (j.error ?? '出错了') : batch && retryingBatches.has(batch) ? '正在重试查询' : null
    })
  }
  const canCancel = jobs.some((j) => (j.status === 'QUEUED' || j.status === 'FAILED') && !j.remoteId && !runningIds.has(j.id) && !packingIds.has(j.id))
  // 队列预览只取前几行，底栏状态要包含后面的任务。
  const working = jobs.some(j => j.status !== 'FAILED' && (runningIds.has(j.id) || packingIds.has(j.id) || j.remoteId || lookBatchFileId(j)))
  const activity = working ? 'working' : jobs.some(j => j.status !== 'FAILED') ? 'queued' : 'idle'
  return { count: jobs.length, activity, rows, canCancel, needsApiKey: !cloudReady() }
}

// 密钥恢复后继续处理原队列，包括已经提交、等待查询结果的批次。
export async function onLookKeyChanged(): Promise<void> {
  if (!config || stopping || !isDatabaseOpen()) return
  await pushState()
  if (cloudReady()) {
    schedulePoll(0)
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

// 启动：上次退出时没做完的放回排队，接着查批量任务，再排新图
export async function initLook(): Promise<void> {
  await archiveReviewedLookFailures()
  await requeueRunningLookJobs()
  await lookSince()
  schedulePoll(10_000)
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
function imageDataUrl(
  info: NonNullable<Awaited<ReturnType<typeof findLookInfo>>>,
  longEdge = LONG_EDGE
): Promise<string | null> {
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
  precomputed?: { existing?: string[]; fields?: SuggestionFields }
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
  return completeLookJob(jobId, { imageId, kind: 'IDENTIFY', origin: 'NONO', model, result: fields, fieldStatus: pendingStatus(fields), usage: usage ?? null }, fields.description)
}

type VisualHints = NonNullable<Parameters<typeof localClues>[2]>['visualHints']

export function shouldEscalateThinking(
  raw: Record<string, unknown>,
  fields: SuggestionFields,
  clues: LocalClues,
  visualHints: VisualHints
): boolean {
  if (clues.photo) return false
  return raw.needs_thinking === true || (!fields.character && (visualHints?.characters?.length ?? 0) > 0)
}

// 一张图的线索
function cluesOf(
  info: NonNullable<Awaited<ReturnType<typeof findLookInfo>>>,
  visualHints: VisualHints = info.visualFeatures ?? null
): LocalClues {
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
  const isReorganize = (job.payload as { reorganize?: boolean } | null)?.reorganize === true
  const existingContext = isReorganize ? await findExistingLookContext(info.id) : null
  const instructions = await realtimeLookInstructions()
  if (!(await allowedLookImages([info.id])).has(info.id)) {
    await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
    return
  }
  if (stopping) return
  try {
    const res1 = await searchCall({
      kind: 'look',
      model: BAILIAN_CONFIG.chatModel,
      imageId: info.id,
      instructions,
      text: lookTail(clues, { existingContext }),
      imageDataUrl: url,
      search: !clues.photo,
      enableThinking: false,
      timeoutMs: TIMEOUT_MS,
      signal: realtimeAbort.signal
    })
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
      if (shouldEscalateThinking(raw1, preliminaryFields, clues, visualHints) && !stopping) {
        try {
          const res2 = await searchCall({
            kind: 'look',
            model: BAILIAN_CONFIG.chatModel,
            imageId: info.id,
            instructions,
            text: lookTail(clues, { existingContext, thinkingRetry: true }),
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

    if (await saveLookResult(job.id, info.id, finalText, clues, finalSources, BAILIAN_CONFIG.chatModel, finalUsage, canonical, canonical ? { existing, fields: finalFields } : undefined)) {
      config?.onSuggested()
    }
  } catch (err) {
    if (stopping) return
    log.warn(`看图失败（图片 ${info.id}）`, err)
    const failure = lookError(err)
    if (failure.inputImageRejected) {
      if (await markRejectedImageForReview(job.id, BAILIAN_CONFIG.chatModel)) config?.onR18?.(1)
    } else {
      await updateJob(job.id, { status: 'FAILED', error: failure.message, finishedAt: new Date() })
    }
  }
}

type CloudLookError = { code?: string; type?: string; status?: number; message?: string; name?: string }

function lookError(err: unknown): { message: string; inputImageRejected?: true } {
  const failure = err as (CloudLookError & { error?: CloudLookError }) | null
  const message = `${failure?.message ?? ''} ${failure?.error?.message ?? ''}`
  const details = `${failure?.code ?? ''} ${failure?.type ?? ''} ${failure?.error?.code ?? ''} ${failure?.error?.type ?? ''} ${message} ${failure?.name ?? ''}`
  const explicitImage = /\binput\s+(?:image|picture)\b|输入(?:的)?(?:图像|图片)/i.test(message)
  const moderation = /data[_ ]?inspection[_ ]?failed|content[_ ]filter/i.test(details) ||
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
  if (submitting) {
    submitAgain = true
    return
  }
  submitting = true
  void (async () => {
    do {
      submitAgain = false
      await submitQueued()
    } while (submitAgain && !stopping)
  })()
    .catch((err: unknown) => log.error('看图队列出错', err))
    .finally(() => {
      submitting = false
    })
}

// 实时看的空位填满
async function fillRealtime(): Promise<void> {
  while (active < CONCURRENCY) {
    if (!(await pumpOne())) {
      break
    }
  }
}

// 排着的超出 50 张的部分、攒够的补图，打成批量交上去
async function submitQueued(): Promise<void> {
  if (suspended || !config?.canRun()) {
    return
  }
  const queued = (await findOpenLookJobs()).filter((j) => j.status === 'QUEUED' && !j.remoteId && !runningIds.has(j.id) && !packingIds.has(j.id))
  const normal = queued.filter((j) => j.priority >= 0)
  const batch = [...queued.filter((j) => j.priority === LOOK_BATCH_PRIORITY), ...normal.slice(BATCH_OVER).filter((j) => j.priority === 0)]
  if (batch.length > 0) {
    await submitBatches(batch)
  }
  // 补图：攒够一批（100 张）再交，分级判完了就把剩下的不满一批也交了
  const backlog = queued.filter((j) => j.priority === LOOK_BACKLOG_PRIORITY)
  const ready = config.moreLater?.() ? Math.floor(backlog.length / BATCH_SIZE) * BATCH_SIZE : backlog.length
  if (ready > 0) {
    await submitBatches(backlog.slice(0, ready))
  }
}

// 取下一张实时看；没有可做的返回 false
async function pumpOne(): Promise<boolean> {
  if (stopping || suspended || !config!.canRun()) {
    return false
  }
  // 补图（优先级为负）只走批量，不在这里实时看；正在打包交批量的也不碰
  const pick = (j: AiJobEntity): boolean => j.status === 'QUEUED' && !j.remoteId && !runningIds.has(j.id) && !packingIds.has(j.id) && j.priority >= 0
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
    if (!packingIds.has(open.id)) {
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
  const n = await cancelOpenLookJobs([...runningIds, ...packingIds])
  await pushState()
  return n
}

// ===== 批量推理 =====

// 一张图的批量请求（Chat Completions，带图，不联网）
async function batchLine(job: AiJobEntity, instructions: string): Promise<string | null> {
  const info = job.imageId ? await findLookInfo(job.imageId) : undefined
  if (!info || !info.cloudAllowed) {
    await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
    return null
  }
  const url = await imageDataUrl(info, BATCH_LONG_EDGE)
  if (!url) {
    await updateJob(job.id, { status: 'FAILED', error: '读不到原图', finishedAt: new Date() })
    return null
  }
  const isReorganize = (job.payload as { reorganize?: boolean } | null)?.reorganize === true
  const existingContext = isReorganize ? await findExistingLookContext(info.id) : null
  const body = {
    model: BAILIAN_CONFIG.chatModel,
    enable_thinking: false,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: [{ type: 'text', text: lookTail(cluesOf(info, info.visualFeatures ?? null), { existingContext }) }, { type: 'image_url', image_url: { url } }] }
    ]
  }
  return JSON.stringify({ custom_id: String(job.id), method: 'POST', url: '/v1/chat/completions', body })
}

// 把一批任务提交成批量推理（每批最多 100 张，带图的请求单独成批）
async function submitBatches(jobs: AiJobEntity[]): Promise<void> {
  if (changingBailianKey || !cloudReady()) return
  jobs.forEach((j) => packingIds.add(j.id))
  try {
    // 已分配给批量的图片在退出恢复后继续走批量，避免再次占用实时配额。
    await preferBatchForLookJobs(jobs.filter((j) => j.priority === 0).map((j) => j.id))
    await submitChunks(jobs)
  } finally {
    jobs.forEach((j) => packingIds.delete(j.id))
  }
  if (stopping) {
    return
  }
  await pushState()
  schedulePoll(BATCH_POLL_MS)
  void fillRealtime().catch((err: unknown) => log.error('看图队列出错', err))
}

// 按每批 100 张逐批打包上传；退出时立刻停下（没交的下次启动再交）
async function submitChunks(jobs: AiJobEntity[]): Promise<void> {
  const cfg = config!
  // 百炼批量输入不享受上下文缓存。词表在本地归一化时读取，云端只保留整理习惯。
  const instructions = `${LOOK_RULES}\n\n${await profileOfConversation(null, false)}`
  for (let i = 0; i < jobs.length && !stopping; i += BATCH_SIZE) {
    const chunk = jobs.slice(i, i + BATCH_SIZE)
    let prepared: Array<{ job: AiJobEntity; line: string }> = []
    for (const j of chunk) {
      if (stopping) {
        return
      }
      const line = await batchLine(j, instructions)
      if (line) {
        prepared.push({ job: j, line })
      }
    }
    if (!prepared.length) {
      continue
    }
    const file = join(cfg.tempDir, `look-batch-${Date.now()}.jsonl`)
    try {
      await mkdir(cfg.tempDir, { recursive: true })
      // 只有打包期间分级有变才重写本地文件；其余图片仍在本批提交。
      while (prepared.length && !stopping) {
        await writeFile(file, prepared.map(entry => entry.line).join('\n'))
        const allowed = await allowedLookImages(prepared.map(entry => entry.job.imageId!))
        const rejected = prepared.filter(entry => !allowed.has(entry.job.imageId!))
        if (!rejected.length) break
        for (const { job } of rejected) await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
        prepared = prepared.filter(entry => allowed.has(entry.job.imageId!))
      }
      if (stopping || !prepared.length) continue
      const client = getBailianClient()
      const upload = await client.files.create({ file: createReadStream(file), purpose: 'batch' }, { signal: realtimeAbort.signal })
      if (stopping) return
      const registration = registerLookBatch(client, prepared.map(entry => entry.job.id), upload.id)
      batchRegistration = registration
      try {
        await registration
      } finally {
        batchRegistration = null
      }
    } catch (err) {
      if (!stopping) {
        log.warn('上传批量看图文件失败', err)
        await failLookBatch(prepared.map(entry => entry.job.id), '批量文件上传失败')
      }
    } finally {
      await rm(file, { force: true }).catch((err: unknown) => log.warn('清理看图批量临时文件失败', err))
    }
  }
}

async function registerLookBatch(client: ReturnType<typeof getBailianClient>, ids: number[], fileId: string): Promise<void> {
  if (!(await rememberLookBatch(ids, fileId))) {
    submitAgain = true
    return
  }
  try {
    const batch = await client.batches.create({ input_file_id: fileId, endpoint: '/v1/chat/completions', completion_window: '24h' }, { timeout: BATCH_READ_TIMEOUT_MS })
    await attachLookBatch(ids, batch.id)
    log.info(`看图批量推理已提交：${batch.id}，${ids.length} 张`)
  } catch (err) {
    // 请求超时也可能已在云端创建成功。使用上传文件 ID 对账，避免重复计费。
    log.warn('批量提交结果待确认，将核对云端任务', err)
    retryingBatches.add(fileId)
    schedulePoll(BATCH_RETRY_MS)
  }
}

// 云端批次需要用提交时的账号查询和取消。保存新密钥期间暂停提交，避免检查后又产生旧账号的批次。
export async function changeLookBatchKey<T>(save: () => Promise<T>): Promise<T> {
  changingBailianKey = true
  try {
    const hasRemote = isDatabaseOpen() && (await findOpenLookJobs()).some((job) =>
      job.status === 'RUNNING' && (job.remoteId || lookBatchFileId(job)))
    if (packingIds.size > 0 || hasRemote) {
      throw new BizError('CONFLICT', '请等批量看图结束后再更换百炼 API Key')
    }
    return await save()
  } finally {
    changingBailianKey = false
  }
}

// 系统休眠时暂停轮询与新任务调度，不破坏进行中的状态
export function pauseLookForSuspend(): void {
  suspended = true
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

// 系统唤醒后恢复看图队列与批量轮询
export function resumeLookAfterSuspend(): void {
  suspended = false
  scheduleLook()
  if (config && !stopping && cloudReady()) {
    schedulePoll(BATCH_RETRY_MS)
  }
}

// 过一会儿查一次批量任务
function schedulePoll(ms: number): void {
  if (pollTimer || stopping || suspended) {
    return
  }
  pollTimer = setTimeout(() => {
    pollTimer = null
    void pollBatches().catch((err: unknown) => log.error('查询批量推理失败', err))
  }, ms)
}

// 一个批次查询失败时继续查其余批次，下一轮再试未取回的结果。
async function pollBatches(): Promise<void> {
  if (stopping || suspended || !cloudReady()) {
    return
  }
  if (polling) {
    schedulePoll(BATCH_POLL_MS)
    return
  }
  polling = true
  let waiting = true
  let retry = false
  try {
    const open = (await findOpenLookJobs()).filter((job) => job.status === 'RUNNING')
    const pending = groupLookJobs(open, lookBatchFileId)
    waiting = false
    if (pending.size > 0) {
      try {
        waiting = await reconcileLookBatches(pending)
      } catch (err) {
        if (stopping) return
        retry = true
        pending.forEach((_jobs, fileId) => retryingBatches.add(fileId))
        log.warn('核对已提交看图批次失败，将重试', err)
      }
    }
    if (stopping) return
    const batches = groupLookJobs(pending.size ? (await findOpenLookJobs()).filter((job) => job.status === 'RUNNING') : open, (job) => job.remoteId)
    const groups = [...batches]
    for (let offset = 0; offset < groups.length && !stopping; offset += 4) {
      await Promise.all(groups.slice(offset, offset + 4).map(async ([id, jobs]) => {
        try {
          const pending = await pollBatch(id, jobs)
          waiting ||= pending
          retryingBatches.delete(id)
        } catch (err) {
          if (stopping) return
          log.warn('查询看图批量结果失败，将继续查询', err)
          retryingBatches.add(id)
          retry = true
        }
      }))
      await pushState()
    }
    if (groups.length === 0 && pending.size > 0) {
      await pushState()
    }
    if (groups.length > 0) scheduleLook()
  } catch (err) {
    if (stopping) return
    retry = true
    throw err
  } finally {
    polling = false
    if (retry || waiting) {
      schedulePoll(retry ? BATCH_RETRY_MS : BATCH_POLL_MS)
    }
  }
}

function groupLookJobs(jobs: AiJobEntity[], keyOf: (job: AiJobEntity) => string | null): Map<string, AiJobEntity[]> {
  const groups = new Map<string, AiJobEntity[]>()
  for (const job of jobs) {
    const key = keyOf(job)
    if (key) {
      const group = groups.get(key) ?? []
      group.push(job)
      groups.set(key, group)
    }
  }
  return groups
}

async function reconcileLookBatches(groups: Map<string, AiJobEntity[]>, closing = false): Promise<boolean> {
  const unmatched = new Map(groups)
  const earliest = Math.min(...[...groups.values()].map(([job]) => job.startedAt?.getTime() ?? 0))
  const options = { timeout: BATCH_READ_TIMEOUT_MS, signal: closing ? undefined : realtimeAbort.signal }
  for await (const batch of getBailianClient().batches.list({ limit: 100 }, options)) {
    if (stopping && !closing) return true
    const jobs = unmatched.get(batch.input_file_id)
    if (jobs) {
      await attachLookBatch(jobs.map((job) => job.id), batch.id)
      unmatched.delete(batch.input_file_id)
      retryingBatches.delete(batch.input_file_id)
    }
    if (unmatched.size === 0 || batch.created_at * 1000 < earliest - 60_000) break
  }
  for (const [fileId, jobs] of unmatched) {
    if (Date.now() - (jobs[0].startedAt?.getTime() ?? 0) >= BATCH_CONFIRM_WINDOW_MS) {
      await failLookBatch(jobs.map((job) => job.id), '未查到提交的批量任务')
      unmatched.delete(fileId)
      retryingBatches.delete(fileId)
    }
  }
  return unmatched.size > 0
}

// 批次仍在处理时返回 true。批次结束后，只把没有可用结果的图片标成失败。
async function pollBatch(id: string, jobs: AiJobEntity[]): Promise<boolean> {
  const client = getBailianClient()
  const options = { timeout: BATCH_READ_TIMEOUT_MS, signal: realtimeAbort.signal }
  const batch = await client.batches.retrieve(id, options)
  if (stopping) return false
  if (!['completed', 'failed', 'expired', 'cancelled'].includes(batch.status)) {
    return true
  }
  const unresolved = new Map(jobs.map((job) => [String(job.id), job]))
  let saved = false
  let reviews = 0
  let canonical: Map<string, string> | undefined
  const files = [...new Set([batch.output_file_id, batch.error_file_id].filter((id): id is string => !!id))]
  const results = await Promise.allSettled(files.map(async (fileId) => (await client.files.content(fileId, options)).text()))
  const lines = results.flatMap((result) => result.status === 'fulfilled' ? result.value.split('\n') : [])
  try {
    for (const line of lines) {
      if (stopping) {
        return false
      }
      if (!line.trim()) {
        continue
      }
      let row: {
        custom_id: string
        error?: CloudLookError
        response?: { status_code?: number; body?: CloudLookError & { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown; error?: CloudLookError } }
      }
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const job = unresolved.get(row?.custom_id)
      if (!job?.imageId) continue
      const body = row?.response?.body
      if (row.response?.status_code !== 200 || !body) {
        const failure = lookError(body?.error ?? row.error ?? body)
        if (failure.inputImageRejected) {
          if (await markRejectedImageForReview(job.id, BAILIAN_CONFIG.chatModel)) reviews++
          unresolved.delete(row.custom_id)
        } else if (failure.message === LOOK_CONTENT_REJECTED) {
          await failLookBatch([job.id], failure.message)
          unresolved.delete(row.custom_id)
        }
        continue
      }
      const usage = await recordBatchUsage({ kind: 'look', model: BAILIAN_CONFIG.chatModel, imageId: job.imageId }, body.usage)
      const info = await findLookInfo(job.imageId)
      if (info && !info.isR18) {
        canonical ??= await loadCanonicalTags()
        const done = await saveLookResult(job.id, job.imageId, body.choices?.[0]?.message?.content, cluesOf(info), null, BAILIAN_CONFIG.chatModel, usage, canonical)
        saved ||= done
      } else {
        await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
      }
      unresolved.delete(row.custom_id)
    }
  } finally {
    if (!stopping && reviews > 0) config?.onR18?.(reviews)
    if (!stopping && saved) config?.onSuggested()
  }
  if (stopping || unresolved.size === 0) return false
  const failedFile = results.find((result) => result.status === 'rejected')
  if (failedFile) throw failedFile.reason
  const toResume = [...unresolved.values()].filter((job) => batch.status === 'cancelled' && resumesAfterLookCancel(job)).map((job) => job.id)
  if (toResume.length > 0) await requeuePausedLookBatch(toResume)
  const failed = [...unresolved.values()].filter((job) => !toResume.includes(job.id)).map((job) => job.id)
  if (failed.length > 0) {
    await failLookBatch(failed, '批量推理没有返回结果')
  }
  return false
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
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  shutdown = cancelLookBatchesOnExit()
  return shutdown
}

async function cancelLookBatchesOnExit(): Promise<void> {
  await batchRegistration?.catch((err: unknown) => log.warn('退出时批量提交状态未能落盘', err))
  if (!isDatabaseOpen() || !cloudReady()) return
  const open = (await findOpenLookJobs()).filter((job) => job.status === 'RUNNING')
  const pending = groupLookJobs(open, lookBatchFileId)
  if (pending.size > 0) {
    await reconcileLookBatches(pending, true).catch((err: unknown) => log.warn('退出时无法确认部分批量任务', err))
  }
  const active = pending.size ? (await findOpenLookJobs()).filter((job) => job.status === 'RUNNING') : open
  const ids = [...groupLookJobs(active, (job) => job.remoteId).keys()]
  if (ids.length === 0) return
  const client = getBailianClient()
  for (let offset = 0; offset < ids.length; offset += 8) {
    await Promise.all(ids.slice(offset, offset + 8).map(async (id) => {
      try {
        await pauseLookBatch(id)
        const options = { timeout: BATCH_CANCEL_TIMEOUT_MS }
        try {
          await client.batches.cancel(id, options)
        } catch (err) {
          const status = (err as { status?: number } | null)?.status
          // 取消是幂等操作，临时网络或服务故障时再请求一次。
          if (!status || status === 408 || status === 429 || status >= 500) {
            await client.batches.cancel(id, options)
          } else {
            const batch = await client.batches.retrieve(id, options)
            if (!['cancelling', 'cancelled', 'completed', 'failed', 'expired'].includes(batch.status)) throw err
          }
        }
      } catch (err) {
        log.warn(`退出时未能确认批量任务已停止：${id}`, err)
      }
    }))
  }
}
