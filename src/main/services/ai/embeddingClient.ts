// 语义向量的云端调用（qwen3-vl-embedding，1024 维）：一张图或一句话换成向量，调用后记账；不自动重试
import { EMBEDDING_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { getLogger } from '../../common/logger'
import { insertApiUsage } from '../../repositories/apiUsageRepository'
import { isEmbeddingVector } from './embeddingVector'

const log = getLogger('embed')

// 要换成向量的内容：一张图（data URL）或一句话
export type EmbedInput = { image: string } | { text: string }

// 调一次向量接口
export async function embed(input: EmbedInput, imageId?: number, signal?: AbortSignal): Promise<number[]> {
  const key = readCloudCredentials().dashscopeApiKey
  if (!key) {
    throw new Error('未配置百炼 API Key')
  }
  const t0 = Date.now()
  let error: string | null = null
  let usage: Record<string, number> = {}
  try {
    const timeout = AbortSignal.timeout(EMBEDDING_CONFIG.timeoutMs)
    const res = await fetch(EMBEDDING_CONFIG.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_CONFIG.model, input: { contents: [input] }, parameters: { dimension: EMBEDDING_CONFIG.dimension } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    const body = ((await res.json().catch(() => null)) ?? {}) as {
      output?: { embeddings?: Array<{ embedding?: number[] }> }
      usage?: Record<string, number>
      code?: string
    }
    usage = body.usage ?? {}
    const vec = body.output?.embeddings?.[0]?.embedding
    if (!res.ok || !isEmbeddingVector(vec)) {
      error = res.ok ? '服务返回了无效向量' : `${res.status} ${body.code ?? ''}`.trim()
      throw new Error(`向量接口出错：${error}`)
    }
    return vec
  } catch (err) {
    error ??= err instanceof Error ? err.name : 'Error'
    throw err
  } finally {
    try {
      await insertApiUsage({
        api: 'embed',
        model: EMBEDDING_CONFIG.model,
        imageId,
        inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.image_tokens ?? 0),
        imageTokens: Number(usage.image_tokens ?? 0),
        latencyMs: Date.now() - t0,
        error
      })
    } catch (e) {
      log.error('记录云端用量失败', e)
    }
  }
}
