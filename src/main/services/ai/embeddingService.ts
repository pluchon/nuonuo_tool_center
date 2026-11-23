// 语义向量（设计 6.7）：过了上云闸门的图在空闲时逐张补向量（R-18 图不生成）；查询文本的向量按原文缓存；
// 上传的图先过本地分级闸门再上云。
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EMBEDDING_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { findLookInfo } from '../../repositories/aiResultRepository'
import { findEmbedCandidates, findIndexedUpload, saveEmbedding, type AiSearchFilter } from '../../repositories/aiSearchRepository'
import { findImageByHash } from '../../repositories/imageRepository'
import { cachedSearchValue, recordLocalReuse, searchCacheKey } from '../../repositories/aiSearchCacheRepository'
import { rateFileNow } from '../rating/ratingService'
import { embed } from './embeddingClient'
import { isEmbeddingVector } from './embeddingVector'
import { prepareImage } from './imagePrep'
import { embeddingBudget, reserveEmbedding } from './aiPolicy'

const log = getLogger('embed')

// 发给向量接口的图：长边 512 就够（图片 token 少一半）
const LONG_EDGE = 512
// 每批取多少张、两张之间歇多久（不和界面抢）
const BATCH = 20
const GAP_MS = 300
// 文搜图既要求画面相关，也要求能区分用户指定的细节，与图库大小无关。
const TEXT_MIN_SIMILARITY = 0.45
const TEXT_MIN_CONTRAST_MARGIN = 0.06
export const IMAGE_MIN_SIMILARITY = 0.6

// 补向量需要的外部信息
export interface EmbedConfig {
  thumbsDir: string
  tempDir: string
  canRun: () => boolean
}

let config: EmbedConfig | null = null
let running: Promise<void> | null = null
let stopping = false
let reschedule = false
let wake: ReturnType<typeof setTimeout> | null = null
function wakeAtMidnight(): void {
  if (wake || stopping) return
  const midnight = new Date()
  midnight.setHours(24, 0, 0, 0)
  wake = setTimeout(() => { wake = null; scheduleEmbedding() }, Math.max(1000, midnight.getTime() - Date.now()))
  wake.unref()
}
const backgroundAbort = new AbortController()

// 配置（启动时调一次）
export function configureEmbedding(next: EmbedConfig): void {
  config = next
}

// 有没有云端凭证
function cloudReady(): boolean {
  return !!readCloudCredentials().dashscopeApiKey
}

// 空闲时补向量：一批一批来，扫描开始或要退出了就停；一张失败跳过（下次再试）
export function scheduleEmbedding(): void {
  if (!config || stopping || !cloudReady()) {
    return
  }
  if (running) {
    reschedule = true
    return
  }
  running = (async () => {
    const cfg = config!
    const failed = new Set<number>()
    let done = 0
    for (;;) {
      if (stopping || !cfg.canRun()) {
        break
      }
      const budget = await embeddingBudget()
      if (budget !== 'available') {
        if (budget === 'exhausted') wakeAtMidnight()
        break
      }
      const ids = (await findEmbedCandidates(EMBEDDING_CONFIG.model, BATCH + failed.size)).filter((id) => !failed.has(id)).slice(0, BATCH)
      if (ids.length === 0) {
        break
      }
      for (const id of ids) {
        if (stopping || !cfg.canRun()) {
          break
        }
        try {
          const info = await findLookInfo(id, true)
          const url = info?.cloudAllowed ? await prepareImage(info, cfg.thumbsDir, LONG_EDGE) : null
          if (!url) {
            failed.add(id)
            continue
          }
          // 缩图期间可能发生复核、标签或分级变动，发送前重新检查检索资格。
          if (!(await findEmbedCandidates(EMBEDDING_CONFIG.model, 1, id)).length) continue
          if (stopping || !cfg.canRun()) break
          if (!await reserveEmbedding()) { wakeAtMidnight(); return }
          await saveEmbedding(id, EMBEDDING_CONFIG.model, await embed({ image: url }, id, backgroundAbort.signal))
          done++
        } catch (err) {
          if (stopping) break
          failed.add(id)
          log.warn(`图片 ${id} 补向量失败`, err)
        }
        await new Promise((r) => setTimeout(r, GAP_MS))
      }
    }
    if (done > 0) {
      log.info(`补了 ${done} 张图的语义向量`)
    }
  })()
    .catch((err: unknown) => log.error('补向量出错', err))
    .finally(() => {
      running = null
      if (reschedule) {
        reschedule = false
        scheduleEmbedding()
      }
    })
}

// 一句话的向量（按原文缓存）；没有凭证或调用失败返回 null，由调用方降级成只用关键词
async function queryVector(text: string): Promise<number[] | null> {
  const key = text.trim()
  if (!key) return null
  try {
    const vector = await cachedSearchValue(
      searchCacheKey('text-vector-v1', [EMBEDDING_CONFIG.model, EMBEDDING_CONFIG.dimension, key]),
      isEmbeddingVector,
      async () => cloudReady() ? embed({ text: key }) : undefined
    )
    return vector ?? null
  } catch (err) {
    log.warn('查询向量失败，这次只用关键词', err)
    return null
  }
}

// 去重时忽略宽窄字符、空白和标点，给模型计算向量时保留原句。
export function contrastDescriptions(text: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const keyOf = (phrase: string): string => phrase.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, '')
  const seen = new Set(['', keyOf(text)])
  const descriptions: string[] = []
  for (const part of raw) {
    if (typeof part !== 'string') continue
    const phrase = part.trim().slice(0, 100)
    const key = keyOf(phrase)
    if (seen.has(key)) continue
    seen.add(key)
    descriptions.push(phrase)
    if (descriptions.length === 2) break
  }
  return descriptions
}

// 只有正例时无法区分同类里的近似图片，保留本地文字检索。
export async function semanticVector(text: string, contrast: unknown): Promise<AiSearchFilter['vector']> {
  const othersText = contrastDescriptions(text, contrast)
  if (!text || !othersText.length) return undefined
  const [values, ...others] = await Promise.all([text, ...othersText].map(queryVector))
  // 反例读取失败时只查元数据，避免网络异常悄悄放宽准入条件。
  if (!values || !others.every((value) => value !== null)) return undefined
  return { model: EMBEDDING_CONFIG.model, minSimilarity: TEXT_MIN_SIMILARITY, values,
    contrast: { values: others, minMargin: TEXT_MIN_CONTRAST_MARGIN } }
}

// 视觉问答与以图检索共用分级结果，只允许上传通过本地分级的这份图像。
export async function prepareRatedUpload(dataUrl: string, originalHash?: string): Promise<string> {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
  if (!m) {
    throw new BizError('BAD_REQUEST', '图片格式不对')
  }
  const cfg = config
  if (!cfg) throw new BizError('DEPENDENCY_FAILED', '本地分级模型还没准备好，这张图先不发给云端')
  await mkdir(cfg.tempDir, { recursive: true })
  const file = join(cfg.tempDir, `upload-${randomUUID()}.jpg`)
  try {
    // 新旧消息在入库前均已转为 512 像素以内的 JPEG，分级和上传使用同一份字节。
    await writeFile(file, Buffer.from(m[1], 'base64'))
    const rated = await rateFileNow(file)
    if (!rated) {
      throw new BizError('DEPENDENCY_FAILED', '本地分级模型还没准备好，这张图先不发给云端')
    }
    if (rated.r18 || (originalHash && (await findImageByHash(originalHash))?.isR18)) {
      throw new BizError('CONFLICT', '这张图本地判为 R-18，不发给云端')
    }
    return dataUrl
  } finally {
    await rm(file, { force: true })
  }
}

export async function uploadVector(dataUrl: string, originalHash?: string, dirs?: AiSearchFilter['dirs']): Promise<number[]> {
  const safe = await prepareRatedUpload(dataUrl, originalHash)
  if (originalHash) {
    const indexed = await findIndexedUpload(originalHash, EMBEDDING_CONFIG.model, dirs)
    if (isEmbeddingVector(indexed)) {
      await recordLocalReuse()
      return indexed
    }
  }
  const bytes = Buffer.from(safe.slice(safe.indexOf(',') + 1), 'base64')
  const key = searchCacheKey('upload-vector-v1', [EMBEDDING_CONFIG.model, EMBEDDING_CONFIG.dimension, 'jpeg-512-v1', createHash('sha256').update(bytes).digest('hex')])
  const vector = await cachedSearchValue(key, isEmbeddingVector, () => embed({ image: safe }))
  if (!vector) throw new BizError('DEPENDENCY_FAILED', '图片向量暂不可用')
  return vector
}

// 退出前停掉
export async function stopEmbedding(): Promise<void> {
  stopping = true
  if (wake) clearTimeout(wake)
  wake = null
  backgroundAbort.abort()
  await running
}

// 是不是正在补向量
export function isEmbedBusy(): boolean {
  return running !== null
}
