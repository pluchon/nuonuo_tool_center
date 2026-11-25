import OpenAI from 'openai'
import type { AiReplyCacheUsage } from '@shared/api'
import { BAILIAN_CONFIG, CACHE_HIT_CHECK, readCloudCredentials } from '../../config/cloudConfig'
import { getLogger } from '../../common/logger'
import { findRecentUsage, insertApiUsage } from '../../repositories/apiUsageRepository'
import { assertCacheMarks, type PromptMessage } from './promptPrefix'
import { collectSearchSources, type SearchSource } from './searchSources'
import {
  HIT_RATE_KINDS,
  normalizeChatUsage,
  reportedChatCache,
  normalizeResponsesUsage,
  textHitRate,
  type ApiKind,
  type NormalizedUsage
} from './usage'

const log = getLogger('ai')

let client: OpenAI | null = null

// 懒加载百炼兼容客户端；关闭自动重试，避免一次超时被重试成多次计费
export function getBailianClient(): OpenAI {
  const { dashscopeApiKey } = readCloudCredentials()
  if (!dashscopeApiKey) {
    throw new Error('未配置百炼 API Key')
  }
  if (client?.apiKey === dashscopeApiKey) return client
  client = new OpenAI({
    apiKey: dashscopeApiKey,
    baseURL: BAILIAN_CONFIG.baseURL,
    timeout: BAILIAN_CONFIG.requestTimeoutMs,
    maxRetries: 0
  })
  return client
}

// 一次调用的记账信息
interface CallMeta {
  kind: ApiKind
  model: string
  imageId?: number
}

// 对话调用的参数；tools 必须是固定的一整套，顺序固定
export interface ChatCallInput extends CallMeta {
  signal?: AbortSignal
  messages: PromptMessage[]
  tools?: unknown[]
  requiredTool?: string
  timeoutMs?: number
  maxTokens?: number
  onDelta?: (delta: string) => void
}

// 对话调用的结果
export interface ChatCallResult {
  message: OpenAI.Chat.Completions.ChatCompletionMessage
  finishReason: string | null
  usage: NormalizedUsage
  cacheUsage?: AiReplyCacheUsage
}

// 带联网搜索的调用结果：sources 只来自搜索工具
export interface SearchCallResult {
  text: string
  sources: SearchSource[]
  usage: NormalizedUsage
}

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  imageTokens: 0,
  outputTokens: 0,
  searchCount: 0
}

// 记账；写库失败只记日志，不影响调用结果
async function record(meta: CallMeta, usage: NormalizedUsage, latencyMs: number, error?: string): Promise<void> {
  try {
    await insertApiUsage({
      api: meta.kind,
      model: meta.model,
      imageId: meta.imageId,
      ...usage,
      latencyMs,
      error: error ? error.slice(0, 200) : null
    })
  } catch (err) {
    log.error('记录云端用量失败', err)
  }
  if (!error && HIT_RATE_KINDS.includes(meta.kind)) {
    await checkHitRate(meta.kind)
  }
}

// 最近一段调用的文本命中率低于目标时写一条警告（只在开发日志里看）
export async function checkHitRate(kind: ApiKind): Promise<number | null> {
  try {
    const rows = await findRecentUsage(kind, CACHE_HIT_CHECK.window)
    if (rows.length < CACHE_HIT_CHECK.minCalls) {
      return null
    }
    const rate = textHitRate(rows)
    if (rate !== null && rate < CACHE_HIT_CHECK.target) {
      log.warn(`${kind} 最近 ${rows.length} 次调用的缓存命中率 ${(rate * 100).toFixed(1)}%，低于 ${CACHE_HIT_CHECK.target * 100}%`)
    }
    return rate
  } catch (err) {
    log.error('计算缓存命中率失败', err)
    return null
  }
}

// 错误只留类型和状态码，不把请求内容写进库和日志
function errorText(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    return `${err.status ?? ''} ${err.name}`.trim()
  }
  return err instanceof Error ? err.name : 'Error'
}

// Chat Completions 调用：关闭思考，固定工具集，调用后记账
export async function chatCall(input: ChatCallInput): Promise<ChatCallResult> {
  assertCacheMarks(input.messages)
  const t0 = Date.now()
  try {
    const body = {
      model: input.model,
      messages: input.messages,
      ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
      ...(input.requiredTool ? { tool_choice: { type: 'function', function: { name: input.requiredTool } } } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      // 百炼扩展参数放在顶层；思考会让输出 token 翻好几倍，诺诺的任务用不到
      enable_thinking: false
    }
    const timeout = input.timeoutMs ?? BAILIAN_CONFIG.chatTimeoutMs
    if (input.onDelta) {
      const stream = (await getBailianClient().chat.completions.create(
        { ...body, stream: true, stream_options: { include_usage: true } } as never,
        { timeout, signal: input.signal }
      )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
      let text = ''
      let finishReason: string | null = null
      let rawUsage: unknown
      const toolCallMap = new Map<number, OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall>()
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          text += delta.content
          input.onDelta(delta.content)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            const entry = toolCallMap.get(idx) ?? {
              id: '',
              type: 'function' as const,
              function: { name: '', arguments: '' }
            }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.function.name += tc.function.name
            if (tc.function?.arguments) entry.function.arguments += tc.function.arguments
            toolCallMap.set(idx, entry)
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) rawUsage = chunk.usage
      }
      const toolCalls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc)
      const message: OpenAI.Chat.Completions.ChatCompletionMessage = {
        role: 'assistant',
        content: text || null,
        refusal: null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      }
      const usage = normalizeChatUsage(rawUsage)
      await record(input, usage, Date.now() - t0)
      return { message, finishReason, usage, cacheUsage: reportedChatCache(rawUsage) }
    }
    const res = await getBailianClient().chat.completions.create(body as never, {
      timeout,
      signal: input.signal
    })
    const usage = normalizeChatUsage(res.usage)
    await record(input, usage, Date.now() - t0)
    const choice = res.choices[0]
    return { message: choice.message, finishReason: choice.finish_reason, usage, cacheUsage: reportedChatCache(res.usage) }
  } catch (err) {
    await record(input, EMPTY_USAGE, Date.now() - t0, errorText(err))
    throw err
  }
}

// 批量推理的结果回来后按条记账
export async function recordBatchUsage(meta: CallMeta, usage: unknown): Promise<NormalizedUsage> {
  const u = normalizeChatUsage(usage)
  try {
    await insertApiUsage({ api: meta.kind, model: meta.model, imageId: meta.imageId, ...u, batch: true })
  } catch (err) {
    log.error('记录云端用量失败', err)
  }
  return u
}

// Responses 调用（看图）：图片放在最后；search 为真时带联网搜索，来源只取搜索工具返回的链接
export async function searchCall(
  meta: CallMeta & { instructions: string; text: string; imageDataUrl?: string; timeoutMs?: number; search?: boolean; signal?: AbortSignal }
): Promise<SearchCallResult> {
  const t0 = Date.now()
  try {
    const content: unknown[] = [{ type: 'input_text', text: meta.text }]
    if (meta.imageDataUrl) {
      content.push({ type: 'input_image', image_url: meta.imageDataUrl })
    }
    const res = (await getBailianClient().responses.create(
      {
        model: meta.model,
        instructions: meta.instructions,
        input: [{ role: 'user', content }],
        ...(meta.search === false ? {} : { tools: [{ type: 'web_search' }] }),
        enable_thinking: false
      } as never,
      { timeout: meta.timeoutMs ?? BAILIAN_CONFIG.requestTimeoutMs, signal: meta.signal }
    )) as unknown as { output?: unknown[]; output_text?: string; usage?: unknown; tool_usage?: unknown }
    const usage = normalizeResponsesUsage(res.usage, res.tool_usage)
    await record(meta, usage, Date.now() - t0)
    return { text: res.output_text ?? '', sources: collectSearchSources(res.output), usage }
  } catch (err) {
    if (!meta.signal?.aborted) await record(meta, EMPTY_USAGE, Date.now() - t0, errorText(err))
    throw err
  }
}
