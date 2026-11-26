// 诺诺看图批量推理调度、JSONL 打包上传、轮询对账与退出取消
import { createReadStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BAILIAN_CONFIG, ORGANIZE_COST } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { bumpLibraryVersion } from '../../common/readCache'
import { isDatabaseOpen } from '../../db/client'
import {
  allowedLookImages,
  attachLookBatch,
  failLookBatch,
  findExistingLookContext,
  findLookInfo,
  findOpenLookJobs,
  lookBatchFileId,
  LOOK_BACKLOG_PRIORITY,
  LOOK_BATCH_PRIORITY,
  LOOK_CONTENT_REJECTED,
  markRejectedImageForReview,
  pauseLookBatch,
  preferBatchForLookJobs,
  rememberLookBatch,
  requeuePausedLookBatch,
  resumesAfterLookCancel,
  updateJob,
  type AiJobEntity
} from '../../repositories/aiResultRepository'
import { getBailianClient, recordBatchUsage } from './bailianClient'
import { type LocalClues, type localClues } from './localClues'
import { LOOK_RULES, lookTail } from './lookPrompt'
import { profileOfConversation } from './profileService'

const log = getLogger('look')

// 队列里超过这么多张时，超出的部分走批量推理
const BATCH_OVER = ORGANIZE_COST.realtimeMax
// 一个批次最多几张（每张图 base64 后几百 KB，批次文件不宜太大）
const BATCH_SIZE = 100
// 多久查一次批量任务
const BATCH_POLL_MS = 60_000
export const BATCH_RETRY_MS = 15_000
const BATCH_READ_TIMEOUT_MS = 20_000
const BATCH_CANCEL_TIMEOUT_MS = 10_000
const BATCH_CONFIRM_WINDOW_MS = 5 * 60_000
// 批量缩到 1024 控制文件体积
const BATCH_LONG_EDGE = 1024

export type CloudLookError = { code?: string; type?: string; status?: number; message?: string; name?: string }

export interface LookErrorClassification {
  message: string
  inputImageRejected?: true
}

export type LookImageInfo = NonNullable<Awaited<ReturnType<typeof findLookInfo>>>
export type LookVisualHints = NonNullable<Parameters<typeof localClues>[2]>['visualHints']

export interface LookBatchHostConfig {
  tempDir: string
  canRun: () => boolean
  onSuggested: () => void
  onR18?: (count: number) => void
  moreLater?: () => boolean
}

export interface LookBatchContext {
  getConfig: () => LookBatchHostConfig | null
  isStopping: () => boolean
  isSuspended: () => boolean
  isCloudReady: () => boolean
  isRealtimeRunning: (jobId: number) => boolean
  getAbortSignal: () => AbortSignal
  pushState: () => Promise<void>
  scheduleLook: () => void
  fillRealtime: () => Promise<void>
  imageDataUrl: (info: LookImageInfo, longEdge?: number) => Promise<string | null>
  cluesOf: (info: LookImageInfo, visualHints?: LookVisualHints) => LocalClues
  loadCanonicalTags: () => Promise<Map<string, string>>
  saveLookResult: (
    jobId: number,
    imageId: number,
    content: unknown,
    clues: LocalClues,
    sources: string[] | null,
    model: string,
    usage: unknown,
    knownTags?: Map<string, string>
  ) => Promise<boolean>
  classifyError: (err: unknown) => LookErrorClassification
}

export interface LookBatchManager {
  scheduleSubmission: () => void
  schedulePoll: (ms: number) => void
  clearPollTimer: () => void
  isPacking: (jobId: number) => boolean
  getPackingIds: () => number[]
  isRetryingBatch: (batchId: string) => boolean
  changeBatchKey: <T>(save: () => Promise<T>) => Promise<T>
  cancelOnExit: () => Promise<void>
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

/**
 * 创建看图批量调度管理器，负责 JSONL 打包上传、云端批次对账轮询与退出取消。
 */
export function createLookBatchManager(ctx: LookBatchContext): LookBatchManager {
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let polling = false
  let batchRegistration: Promise<void> | null = null
  const retryingBatches = new Set<string>()
  const packingIds = new Set<number>()
  let submitting = false
  let submitAgain = false
  let changingBailianKey = false

  function clearPollTimer(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  // 过一会儿查一次批量任务
  function schedulePoll(ms: number): void {
    if (pollTimer || ctx.isStopping() || ctx.isSuspended()) {
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = null
      void pollBatches().catch((err: unknown) => log.error('查询批量推理失败', err))
    }, ms)
  }

  // 一张图的批量请求（Chat Completions，带图，不联网）
  async function batchLine(job: AiJobEntity, instructions: string): Promise<string | null> {
    const info = job.imageId ? await findLookInfo(job.imageId) : undefined
    if (!info || !info.cloudAllowed) {
      await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
      return null
    }
    const url = await ctx.imageDataUrl(info, BATCH_LONG_EDGE)
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
        { role: 'user', content: [{ type: 'text', text: lookTail(ctx.cluesOf(info, info.visualFeatures ?? null), { existingContext }) }, { type: 'image_url', image_url: { url } }] }
      ]
    }
    return JSON.stringify({ custom_id: String(job.id), method: 'POST', url: '/v1/chat/completions', body })
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

  // 按每批 100 张逐批打包上传；退出时立刻停下（没交的下次启动再交）
  async function submitChunks(jobs: AiJobEntity[]): Promise<void> {
    const cfg = ctx.getConfig()!
    // 百炼批量输入不享受上下文缓存。词表在本地归一化时读取，云端只保留整理习惯。
    const instructions = `${LOOK_RULES}\n\n${await profileOfConversation(null, false)}`
    for (let i = 0; i < jobs.length && !ctx.isStopping(); i += BATCH_SIZE) {
      const chunk = jobs.slice(i, i + BATCH_SIZE)
      let prepared: Array<{ job: AiJobEntity; line: string }> = []
      for (const j of chunk) {
        if (ctx.isStopping()) {
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
        while (prepared.length && !ctx.isStopping()) {
          await writeFile(file, prepared.map(entry => entry.line).join('\n'))
          const allowed = await allowedLookImages(prepared.map(entry => entry.job.imageId!))
          const rejected = prepared.filter(entry => !allowed.has(entry.job.imageId!))
          if (!rejected.length) break
          for (const { job } of rejected) await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
          prepared = prepared.filter(entry => allowed.has(entry.job.imageId!))
        }
        if (ctx.isStopping() || !prepared.length) continue
        const client = getBailianClient()
        const upload = await client.files.create({ file: createReadStream(file), purpose: 'batch' }, { signal: ctx.getAbortSignal() })
        if (ctx.isStopping()) return
        const registration = registerLookBatch(client, prepared.map(entry => entry.job.id), upload.id)
        batchRegistration = registration
        try {
          await registration
        } finally {
          batchRegistration = null
        }
      } catch (err) {
        if (!ctx.isStopping()) {
          log.warn('上传批量看图文件失败', err)
          await failLookBatch(prepared.map(entry => entry.job.id), '批量文件上传失败')
        }
      } finally {
        await rm(file, { force: true }).catch((err: unknown) => log.warn('清理看图批量临时文件失败', err))
      }
    }
  }

  // 把一批任务提交成批量推理（每批最多 100 张，带图的请求单独成批）
  async function submitBatches(jobs: AiJobEntity[]): Promise<void> {
    if (changingBailianKey || !ctx.isCloudReady()) return
    jobs.forEach((j) => packingIds.add(j.id))
    try {
      // 已分配给批量的图片在退出恢复后继续走批量，避免再次占用实时配额。
      await preferBatchForLookJobs(jobs.filter((j) => j.priority === 0).map((j) => j.id))
      await submitChunks(jobs)
    } finally {
      jobs.forEach((j) => packingIds.delete(j.id))
    }
    if (ctx.isStopping()) {
      return
    }
    await ctx.pushState()
    schedulePoll(BATCH_POLL_MS)
    void ctx.fillRealtime().catch((err: unknown) => log.error('看图队列出错', err))
  }

  // 排着的超出 50 张的部分、攒够的补图，打成批量交上去
  async function submitQueued(): Promise<void> {
    const cfg = ctx.getConfig()
    if (ctx.isSuspended() || !cfg?.canRun()) {
      return
    }
    const queued = (await findOpenLookJobs()).filter(
      (j) => j.status === 'QUEUED' && !j.remoteId && !ctx.isRealtimeRunning(j.id) && !packingIds.has(j.id)
    )
    const isRefreshJob = (j: AiJobEntity): boolean => (j.payload as { refreshSuggestion?: boolean } | null)?.refreshSuggestion === true
    const normal = queued.filter((j) => j.priority >= 0 && !isRefreshJob(j))
    const batch = [...queued.filter((j) => j.priority === LOOK_BATCH_PRIORITY && !isRefreshJob(j)), ...normal.slice(BATCH_OVER).filter((j) => j.priority === 0)]
    if (batch.length > 0) {
      await submitBatches(batch)
    }
    // 补图：攒够一批（100 张）再交，分级判完了就把剩下的不满一批也交了
    const backlog = queued.filter((j) => j.priority === LOOK_BACKLOG_PRIORITY)
    const ready = cfg.moreLater?.() ? Math.floor(backlog.length / BATCH_SIZE) * BATCH_SIZE : backlog.length
    if (ready > 0) {
      await submitBatches(backlog.slice(0, ready))
    }
  }

  // 交批量同一时间只跑一路；跑着时又被叫到，跑完再来一轮（免得两路把同一批图各交一次）
  function scheduleSubmission(): void {
    if (submitting) {
      submitAgain = true
      return
    }
    submitting = true
    void (async () => {
      do {
        submitAgain = false
        await submitQueued()
      } while (submitAgain && !ctx.isStopping())
    })()
      .catch((err: unknown) => log.error('看图队列出错', err))
      .finally(() => {
        submitting = false
      })
  }

  async function reconcileLookBatches(groups: Map<string, AiJobEntity[]>, closing = false): Promise<boolean> {
    const unmatched = new Map(groups)
    const earliest = Math.min(...[...groups.values()].map(([job]) => job.startedAt?.getTime() ?? 0))
    const options = { timeout: BATCH_READ_TIMEOUT_MS, signal: closing ? undefined : ctx.getAbortSignal() }
    for await (const batch of getBailianClient().batches.list({ limit: 100 }, options)) {
      if (ctx.isStopping() && !closing) return true
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
    const options = { timeout: BATCH_READ_TIMEOUT_MS, signal: ctx.getAbortSignal() }
    const batch = await client.batches.retrieve(id, options)
    if (ctx.isStopping()) return false
    if (!['completed', 'failed', 'expired', 'cancelled'].includes(batch.status)) {
      return true
    }
    const unresolved = new Map(jobs.map((job) => [String(job.id), job]))
    let saved = false
    let reviews = 0
    let canonical: Map<string, string> | undefined
    const files = [...new Set([batch.output_file_id, batch.error_file_id].filter((fileId): fileId is string => !!fileId))]
    const results = await Promise.allSettled(files.map(async (fileId) => (await client.files.content(fileId, options)).text()))
    const lines = results.flatMap((result) => result.status === 'fulfilled' ? result.value.split('\n') : [])
    try {
      for (const line of lines) {
        if (ctx.isStopping()) {
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
          const failure = ctx.classifyError(body?.error ?? row.error ?? body)
          if (failure.inputImageRejected) {
            if (await markRejectedImageForReview(job.id, BAILIAN_CONFIG.chatModel)) {
              bumpLibraryVersion()
              reviews++
            }
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
          canonical ??= await ctx.loadCanonicalTags()
          const done = await ctx.saveLookResult(job.id, job.imageId, body.choices?.[0]?.message?.content, ctx.cluesOf(info), null, BAILIAN_CONFIG.chatModel, usage, canonical)
          saved ||= done
        } else {
          await updateJob(job.id, { status: 'CANCELLED', finishedAt: new Date() })
        }
        unresolved.delete(row.custom_id)
      }
    } finally {
      if (!ctx.isStopping() && reviews > 0) ctx.getConfig()?.onR18?.(reviews)
      if (!ctx.isStopping() && saved) ctx.getConfig()?.onSuggested()
    }
    if (ctx.isStopping() || unresolved.size === 0) return false
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

  // 一个批次查询失败时继续查其余批次，下一轮再试未取回的结果。
  async function pollBatches(): Promise<void> {
    if (ctx.isStopping() || ctx.isSuspended() || !ctx.isCloudReady()) {
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
          if (ctx.isStopping()) return
          retry = true
          pending.forEach((_jobs, fileId) => retryingBatches.add(fileId))
          log.warn('核对已提交看图批次失败，将重试', err)
        }
      }
      if (ctx.isStopping()) return
      const batches = groupLookJobs(pending.size ? (await findOpenLookJobs()).filter((job) => job.status === 'RUNNING') : open, (job) => job.remoteId)
      const groups = [...batches]
      for (let offset = 0; offset < groups.length && !ctx.isStopping(); offset += 4) {
        await Promise.all(groups.slice(offset, offset + 4).map(async ([id, jobs]) => {
          try {
            const pendingBatch = await pollBatch(id, jobs)
            waiting ||= pendingBatch
            retryingBatches.delete(id)
          } catch (err) {
            if (ctx.isStopping()) return
            log.warn('查询看图批量结果失败，将继续查询', err)
            retryingBatches.add(id)
            retry = true
          }
        }))
        await ctx.pushState()
      }
      if (groups.length === 0 && pending.size > 0) {
        await ctx.pushState()
      }
      if (groups.length > 0) ctx.scheduleLook()
    } catch (err) {
      if (ctx.isStopping()) return
      retry = true
      throw err
    } finally {
      polling = false
      if (retry || waiting) {
        schedulePoll(retry ? BATCH_RETRY_MS : BATCH_POLL_MS)
      }
    }
  }

  // 云端批次需要用提交时的账号查询和取消。保存新密钥期间暂停提交，避免检查后又产生旧账号的批次。
  async function changeBatchKey<T>(save: () => Promise<T>): Promise<T> {
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

  async function cancelOnExit(): Promise<void> {
    await batchRegistration?.catch((err: unknown) => log.warn('退出时批量提交状态未能落盘', err))
    if (!isDatabaseOpen() || !ctx.isCloudReady()) return
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

  return {
    scheduleSubmission,
    schedulePoll,
    clearPollTimer,
    isPacking: (jobId: number) => packingIds.has(jobId),
    getPackingIds: () => [...packingIds],
    isRetryingBatch: (batchId: string) => retryingBatches.has(batchId),
    changeBatchKey,
    cancelOnExit
  }
}
