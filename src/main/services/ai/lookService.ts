// 诺诺看图队列（设计 6.5）：新导入、还没打标签、过了本地分级闸门的非 R-18 图自动排队；
// 平时逐张实时看（并发 2、单张 5 分钟超时、不自动重试，出错的挂标签由你重试），一次排进 50 张以上时超出的部分走批量推理（半价）。
// 结果存成 AI 建议，等你逐项确认
import { createReadStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LookStateVO } from '@shared/api'
import { BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { findActiveSettings, upsertSettings } from '../../repositories/appSettingRepository'
import {
  cancelOpenLookJobs,
  fillDescription,
  findLookBriefs,
  findLookCandidates,
  findLookInfo,
  findOpenLookJobs,
  insertAiResult,
  insertLookJobs,
  requeueRunningLookJobs,
  updateJob,
  type AiJobEntity
} from '../../repositories/aiResultRepository'
import { findTagNamesOf, findVocabulary } from '../../repositories/aiSearchRepository'
import { getBailianClient, recordBatchUsage, searchCall } from './bailianClient'
import { localClues, type ClueExif, type LocalClues } from './localClues'
import { LOOK_RULES, lookTail } from './lookPrompt'
import { prepareImage } from './imagePrep'
import { profileOfConversation } from './profileService'
import { keepToolSources } from './searchSources'
import { parseAssistJson as parseJsonBlock } from '@shared/assistJson'
import { normalizeFields, pendingStatus, type SuggestionFields } from './suggestion'

const log = getLogger('look')

// 实时看图的并发数、单张超时
const CONCURRENCY = 2
const TIMEOUT_MS = 5 * 60_000
// 队列里超过这么多张时，超出的部分走批量推理
const BATCH_OVER = 50
// 一个批次最多几张（每张图 base64 后几百 KB，批次文件不宜太大）
const BATCH_SIZE = 100
// 多久查一次批量任务
const BATCH_POLL_MS = 5 * 60_000
// 发给模型的图：长边缩到 1024
const LONG_EDGE = 1024
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
}

let config: LookConfig | null = null
let since: Date | null = null
let active = 0
let stopping = false
let pollTimer: ReturnType<typeof setTimeout> | null = null
// 正在实时看的任务
const runningIds = new Set<number>()

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
    rows.push({
      jobId: j.id,
      imageId: j.imageId,
      name: info.name,
      hash: info.hash,
      state: j.status === 'FAILED' ? ('FAILED' as const) : runningIds.has(j.id) ? ('RUNNING' as const) : ('QUEUED' as const),
      error: j.status === 'FAILED' ? (j.error ?? '出错了') : null
    })
  }
  return { count: jobs.length, rows }
}

// 推一次状态
async function pushState(): Promise<void> {
  try {
    config?.onState(await getLookState())
  } catch (err) {
    log.error('读看图队列失败', err)
  }
}

// 启动：上次退出时没做完的放回排队，接着查批量任务，再排新图
export async function initLook(): Promise<void> {
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
  const ids = await findLookCandidates(await lookSince(), 1000)
  if (ids.length > 0) {
    await insertLookJobs(ids)
    log.info(`看图队列：新排进 ${ids.length} 张`)
  }
  await pushState()
  scheduleLook()
}

// 把图缩到长边 1024、去掉元信息，转成 data URL；原图读不了（RAW、目录离线）时用缩略图
function imageDataUrl(info: NonNullable<Awaited<ReturnType<typeof findLookInfo>>>): Promise<string | null> {
  return prepareImage(info, config!.thumbsDir, LONG_EDGE)
}

// 整理时用的图库信息：叫法对齐表、这张图已有的标签
async function normalizeContext(imageId: number): Promise<{ canonical: Map<string, string>; existing: string[] }> {
  const vocab = await findVocabulary()
  const canonical = new Map<string, string>()
  for (const t of vocab) {
    for (const n of [t.name, ...t.aliases]) {
      canonical.set(n.toLowerCase(), t.name)
    }
  }
  return { canonical, existing: (await findTagNamesOf([imageId])).get(imageId) ?? [] }
}

// 存下看图结果：整理成建议、描述直接补上（不覆盖已有的）
async function saveLookResult(imageId: number, raw: Record<string, unknown> | null, clues: LocalClues, sources: string[] | null, model: string, usage: unknown): Promise<void> {
  const fields: SuggestionFields = normalizeFields(raw ?? {}, await normalizeContext(imageId))
  // 出处：文件名能确定的直接用；否则只要搜索工具返回过的链接（批量里没有搜索，只用文件名的）
  if (clues.source) {
    fields.source = clues.source
  } else if (fields.source && !(sources && keepToolSources([fields.source], sources.map((url) => ({ url }))).length > 0)) {
    fields.source = ''
  }
  if (!fields.character && clues.character) {
    fields.character = clues.character
  }
  await insertAiResult({ imageId, kind: 'IDENTIFY', origin: 'NONO', model, result: fields, fieldStatus: pendingStatus(fields), usage: usage ?? null })
  if (fields.description) {
    await fillDescription(imageId, fields.description)
  }
  config?.onSuggested()
}

// 一张图的线索
function cluesOf(info: NonNullable<Awaited<ReturnType<typeof findLookInfo>>>): LocalClues {
  return localClues(info.relPath?.split('\\').pop() ?? '', (info.exif as ClueExif | null) ?? null)
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
  const clues = cluesOf(info)
  const instructions = `${LOOK_RULES}\n\n${await profileOfConversation(null)}`
  try {
    const res = await searchCall({
      kind: 'look',
      model: BAILIAN_CONFIG.chatModel,
      imageId: info.id,
      instructions,
      text: lookTail(clues),
      imageDataUrl: url,
      search: !clues.photo && !clues.source,
      timeoutMs: TIMEOUT_MS
    })
    await saveLookResult(info.id, parseJsonBlock(res.text), clues, res.sources.map((s) => s.url), BAILIAN_CONFIG.chatModel, res.usage)
    await updateJob(job.id, { status: 'DONE', error: null, finishedAt: new Date() })
  } catch (err) {
    const timeout = err instanceof Error && /timed? ?out|超时/i.test(err.message + err.name)
    log.warn(`看图失败（图片 ${info.id}）`, err)
    await updateJob(job.id, { status: 'FAILED', error: timeout ? '超时' : '网络异常', finishedAt: new Date() })
  }
}

// 开始干活：先把超出 50 张的部分打成批量，再用两个并发逐张实时看
export function scheduleLook(): void {
  if (!config || stopping || !cloudReady()) {
    return
  }
  void (async () => {
    const queued = (await findOpenLookJobs()).filter((j) => j.status === 'QUEUED' && !j.remoteId && !runningIds.has(j.id))
    if (queued.length > BATCH_OVER) {
      await submitBatches(queued.slice(BATCH_OVER).filter((j) => j.priority === 0))
    }
    while (active < CONCURRENCY) {
      if (!(await pumpOne())) {
        break
      }
    }
  })().catch((err: unknown) => log.error('看图队列出错', err))
}

// 取下一张实时看；没有可做的返回 false
async function pumpOne(): Promise<boolean> {
  if (stopping || !config!.canRun()) {
    return false
  }
  const next = (await findOpenLookJobs()).find((j) => j.status === 'QUEUED' && !j.remoteId && !runningIds.has(j.id))
  if (!next) {
    return false
  }
  active++
  runningIds.add(next.id)
  await updateJob(next.id, { status: 'RUNNING', startedAt: new Date(), attempts: next.attempts + 1 })
  await pushState()
  void lookOne(next)
    .catch((err: unknown) => log.error('看图出错', err))
    .finally(async () => {
      active--
      runningIds.delete(next.id)
      await pushState()
      scheduleLook()
    })
  return true
}

// 重试一张出错的
export async function retryLook(jobId: number): Promise<void> {
  await updateJob(jobId, { status: 'QUEUED', error: null, remoteId: null, startedAt: null, finishedAt: null })
  await pushState()
  scheduleLook()
}

// 让某张图现在就看：排到最前面（已经在队列里就提优先级）
export async function lookNow(imageId: number): Promise<void> {
  const open = (await findOpenLookJobs()).find((j) => j.imageId === imageId)
  if (open) {
    if (open.status === 'FAILED' || (open.status === 'QUEUED' && !open.remoteId)) {
      await updateJob(open.id, { status: 'QUEUED', priority: 10, error: null })
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
  const n = await cancelOpenLookJobs()
  await pushState()
  return n
}

// ===== 批量推理 =====

// 一张图的批量请求（Chat Completions，带图，不联网）
async function batchLine(job: AiJobEntity): Promise<string | null> {
  const info = job.imageId ? await findLookInfo(job.imageId) : undefined
  if (!info || !info.cloudAllowed) {
    await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
    return null
  }
  const url = await imageDataUrl(info)
  if (!url) {
    await updateJob(job.id, { status: 'FAILED', error: '读不到原图', finishedAt: new Date() })
    return null
  }
  const body = {
    model: BAILIAN_CONFIG.chatModel,
    enable_thinking: false,
    messages: [
      { role: 'system', content: `${LOOK_RULES}\n\n${await profileOfConversation(null)}` },
      { role: 'user', content: [{ type: 'text', text: lookTail(cluesOf(info)) }, { type: 'image_url', image_url: { url } }] }
    ]
  }
  return JSON.stringify({ custom_id: String(job.id), method: 'POST', url: '/v1/chat/completions', body })
}

// 把一批任务提交成批量推理（每批最多 100 张，带图的请求单独成批）
async function submitBatches(jobs: AiJobEntity[]): Promise<void> {
  const cfg = config!
  for (let i = 0; i < jobs.length && !stopping; i += BATCH_SIZE) {
    const chunk = jobs.slice(i, i + BATCH_SIZE)
    const lines: string[] = []
    const ids: number[] = []
    for (const j of chunk) {
      const line = await batchLine(j)
      if (line) {
        lines.push(line)
        ids.push(j.id)
      }
    }
    if (lines.length === 0) {
      continue
    }
    await mkdir(cfg.tempDir, { recursive: true })
    const file = join(cfg.tempDir, `look-batch-${Date.now()}.jsonl`)
    try {
      await writeFile(file, lines.join('\n'))
      const client = getBailianClient()
      const up = await client.files.create({ file: createReadStream(file), purpose: 'batch' })
      const batch = await client.batches.create({ input_file_id: up.id, endpoint: '/v1/chat/completions', completion_window: '24h' })
      for (const id of ids) {
        await updateJob(id, { status: 'RUNNING', remoteId: batch.id, startedAt: new Date() })
      }
      log.info(`看图批量推理已提交：${batch.id}，${ids.length} 张`)
    } catch (err) {
      log.warn('提交批量推理失败，这些图留在队列里逐张看', err)
    } finally {
      await rm(file, { force: true })
    }
  }
  await pushState()
  schedulePoll(BATCH_POLL_MS)
}

// 过一会儿查一次批量任务
function schedulePoll(ms: number): void {
  if (pollTimer || stopping) {
    return
  }
  pollTimer = setTimeout(() => {
    pollTimer = null
    void pollBatches().catch((err: unknown) => log.error('查询批量推理失败', err))
  }, ms)
}

// 查所有已提交的批量任务：完成的取回结果，失败、过期的把图标成出错
async function pollBatches(): Promise<void> {
  if (!cloudReady()) {
    return
  }
  const remote = (await findOpenLookJobs()).filter((j) => j.remoteId && j.status === 'RUNNING')
  const batchIds = [...new Set(remote.map((j) => j.remoteId as string))]
  if (batchIds.length === 0) {
    return
  }
  const client = getBailianClient()
  let waiting = false
  for (const bid of batchIds) {
    const b = await client.batches.retrieve(bid)
    const mine = remote.filter((j) => j.remoteId === bid)
    if (b.status === 'completed' && b.output_file_id) {
      const text = await (await client.files.content(b.output_file_id)).text()
      const done = new Set<number>()
      for (const line of text.split('\n').filter((l) => l.trim())) {
        const row = JSON.parse(line) as { custom_id: string; response?: { status_code?: number; body?: { choices?: Array<{ message?: { content?: string } }>; usage?: unknown } } }
        const job = mine.find((j) => String(j.id) === row.custom_id)
        if (!job || !job.imageId) {
          continue
        }
        done.add(job.id)
        const body = row.response?.body
        if (row.response?.status_code !== 200 || !body) {
          await updateJob(job.id, { status: 'FAILED', error: '批量推理失败', remoteId: null, finishedAt: new Date() })
          continue
        }
        const usage = await recordBatchUsage({ kind: 'look', model: BAILIAN_CONFIG.chatModel, imageId: job.imageId }, body.usage)
        const info = await findLookInfo(job.imageId)
        if (!info || info.isR18) {
          await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
          continue
        }
        await saveLookResult(job.imageId, parseJsonBlock(body.choices?.[0]?.message?.content ?? ''), cluesOf(info), null, BAILIAN_CONFIG.chatModel, usage)
        await updateJob(job.id, { status: 'DONE', finishedAt: new Date() })
      }
      for (const j of mine.filter((x) => !done.has(x.id))) {
        await updateJob(j.id, { status: 'FAILED', error: '批量推理失败', remoteId: null, finishedAt: new Date() })
      }
    } else if (['failed', 'expired', 'cancelled'].includes(b.status)) {
      for (const j of mine) {
        await updateJob(j.id, { status: 'FAILED', error: '批量推理失败', remoteId: null, finishedAt: new Date() })
      }
    } else {
      waiting = true
    }
  }
  await pushState()
  if (waiting) {
    schedulePoll(BATCH_POLL_MS)
  }
}

// 是不是正在实时看图（做梦时看忙不忙）
export function isLookBusy(): boolean {
  return active > 0
}

// 退出前：不再开始新的，手上的不等（下次启动放回排队）
export function stopLook(): void {
  stopping = true
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}
