// 语义向量（设计 6.7）：过了上云闸门的图在空闲时逐张补向量（R-18 图不生成）；查询文本的向量按原文缓存；
// 上传的图先过本地分级闸门再上云；两路结果按排名融合（RRF）
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EMBEDDING_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'
import { findLookInfo } from '../../repositories/aiResultRepository'
import { findEmbedCandidates, saveEmbedding } from '../../repositories/aiSearchRepository'
import { rateFileNow } from '../rating/ratingService'
import { embed } from './embeddingClient'
import { prepareImage, toDataUrl } from './imagePrep'

const log = getLogger('embed')

// 发给向量接口的图：长边 512 就够（图片 token 少一半）
const LONG_EDGE = 512
// 每批取多少张、两张之间歇多久（不和界面抢）
const BATCH = 20
const GAP_MS = 300
// 查询向量缓存多少条
const CACHE_MAX = 500
// 语义检索的相似度门槛：中文描述对图（实测对得上约 0.6、对不上约 0.24）、图对图（构图相近但内容不同的约 0.54，几乎一样的 0.9 以上）
export const TEXT_MIN_SIMILARITY = 0.35
export const IMAGE_MIN_SIMILARITY = 0.6
// RRF 的平滑常数
const RRF_K = 60

// 补向量需要的外部信息
export interface EmbedConfig {
  thumbsDir: string
  tempDir: string
  canRun: () => boolean
}

let config: EmbedConfig | null = null
let running: Promise<void> | null = null
let stopping = false
const queryCache = new Map<string, number[]>()

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
  if (!config || running || stopping || !cloudReady()) {
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
      const ids = (await findEmbedCandidates(EMBEDDING_CONFIG.model, BATCH + failed.size)).filter((id) => !failed.has(id)).slice(0, BATCH)
      if (ids.length === 0) {
        break
      }
      for (const id of ids) {
        if (stopping || !cfg.canRun()) {
          break
        }
        const info = await findLookInfo(id)
        const url = info?.cloudAllowed ? await prepareImage(info, cfg.thumbsDir, LONG_EDGE) : null
        if (!url) {
          failed.add(id)
          continue
        }
        try {
          await saveEmbedding(id, EMBEDDING_CONFIG.model, await embed({ image: url }, id))
          done++
        } catch (err) {
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
    })
}

// 一句话的向量（按原文缓存）；没有凭证或调用失败返回 null，由调用方降级成只用关键词
export async function queryVector(text: string): Promise<number[] | null> {
  const key = text.trim()
  if (!key || !cloudReady()) {
    return null
  }
  const hit = queryCache.get(key)
  if (hit) {
    return hit
  }
  try {
    const vec = await embed({ text: key })
    if (queryCache.size >= CACHE_MAX) {
      queryCache.delete(queryCache.keys().next().value as string)
    }
    queryCache.set(key, vec)
    return vec
  } catch (err) {
    log.warn('查询向量失败，这次只用关键词', err)
    return null
  }
}

// 上传的图换成向量：先在本地分级，明显 R-18 或判不了的不发给云端
export async function uploadVector(dataUrl: string): Promise<number[]> {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
  if (!m) {
    throw new BizError('BAD_REQUEST', '图片格式不对')
  }
  const cfg = config!
  await mkdir(cfg.tempDir, { recursive: true })
  const file = join(cfg.tempDir, `upload-${Date.now()}.jpg`)
  try {
    const small = await toDataUrl(Buffer.from(m[1], 'base64'), LONG_EDGE)
    await writeFile(file, Buffer.from(small.split(',')[1], 'base64'))
    const rated = await rateFileNow(file)
    if (!rated) {
      throw new BizError('DEPENDENCY_FAILED', '本地分级模型还没准备好，这张图先不发给云端')
    }
    if (rated.r18) {
      throw new BizError('CONFLICT', '这张图本地判为 R-18，不发给云端')
    }
    return await embed({ image: small })
  } finally {
    await rm(file, { force: true })
  }
}

// 两路结果按排名融合：每一路里排第 r 名得 1 / (K + r)，加起来从高到低
export function rrf(lists: number[][], limit: number): number[] {
  const score = new Map<number, number>()
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)))
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id]) => id)
}

// 退出前停掉
export function stopEmbedding(): void {
  stopping = true
}

// 是不是正在补向量
export function isEmbedBusy(): boolean {
  return running !== null
}
