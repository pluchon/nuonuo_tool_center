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
  temperature?: number
  presencePenalty?: number
  parallelToolCalls?: boolean
  enableThinking?: boolean
  thinkingBudget?: number
  onDelta?: (delta: string) => void
}

// 对话调用的结果
export interface ChatCallResult {
  message: OpenAI.Chat.Completions.ChatCompletionMessage
  finishReason: string | null
  usage: NormalizedUsage
  cacheUsage?: AiReplyCacheUsage
  reasoningContent?: string
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

function readReasoningContent(message: unknown): string | undefined {
  const rc = (message as { reasoning_content?: unknown } | null | undefined)?.reasoning_content
  return typeof rc === 'string' && rc.length > 0 ? rc : undefined
}

// Chat Completions 调用：按需配置思考与采样参数，固定工具集，调用后记账
export async function chatCall(input: ChatCallInput): Promise<ChatCallResult> {
  assertCacheMarks(input.messages)
  const t0 = Date.now()
  try {
    const defaultChatSampling = input.kind === 'chat' && !input.requiredTool && !input.enableThinking
    const temperature = input.temperature ?? (defaultChatSampling ? 0.78 : undefined)
    const presencePenalty = input.presencePenalty ?? (defaultChatSampling ? 0.25 : undefined)
    const body = {
      model: input.model,
      messages: input.messages,
      ...(input.tools && input.tools.length > 0
        ? {
            tools: input.tools,
            parallel_tool_calls: input.parallelToolCalls ?? true
          }
        : {}),
      ...(input.requiredTool ? { tool_choice: { type: 'function', function: { name: input.requiredTool } } } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(presencePenalty !== undefined ? { presence_penalty: presencePenalty } : {}),
      // 百炼扩展参数放在顶层
      enable_thinking: input.enableThinking === true,
      ...(input.enableThinking && input.thinkingBudget ? { thinking_budget: input.thinkingBudget } : {})
    }
    const timeout = input.timeoutMs ?? BAILIAN_CONFIG.chatTimeoutMs
    if (input.onDelta) {
      const { data: stream, response } = (await getBailianClient().chat.completions
        .create({ ...body, stream: true, stream_options: { include_usage: true } } as never, {
          timeout,
          signal: input.signal
        })
        .withResponse()) as unknown as {
        data: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
        response: Response
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (contentType.includes('application/json') && !response.bodyUsed) {
        const res = (await response.json()) as OpenAI.Chat.Completions.ChatCompletion
        const usage = normalizeChatUsage(res.usage)
        await record(input, usage, Date.now() - t0)
        const choice = res.choices[0]
        if (typeof choice.message.content === 'string' && choice.message.content.length > 0) {
          input.onDelta(choice.message.content)
        }
        const reasoningContent = readReasoningContent(choice.message)
        return {
          message: choice.message,
          finishReason: choice.finish_reason,
          usage,
          cacheUsage: reportedChatCache(res.usage),
          ...(reasoningContent ? { reasoningContent } : {})
        }
      }
      let text = ''
      let reasoningContent = ''
      let finishReason: string | null = null
      let rawUsage: unknown
      const toolCallMap = new Map<number, OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall>()
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0]
        const delta = choice?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string }) | undefined
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          reasoningContent += delta.reasoning_content
        }
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
      return {
        message,
        finishReason,
        usage,
        cacheUsage: reportedChatCache(rawUsage),
        ...(reasoningContent ? { reasoningContent } : {})
      }
    }
    const res = await getBailianClient().chat.completions.create(body as never, {
      timeout,
      signal: input.signal
    })
    const usage = normalizeChatUsage(res.usage)
    await record(input, usage, Date.now() - t0)
    const choice = res.choices[0]
    const reasoningContent = readReasoningContent(choice.message)
    return {
      message: choice.message,
      finishReason: choice.finish_reason,
      usage,
      cacheUsage: reportedChatCache(res.usage),
      ...(reasoningContent ? { reasoningContent } : {})
    }
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

// Responses：流式 SSE 保活（防止联网搜索长耗时被网关/套接字断开）并返回最终结果；若响应为非流式 JSON（如测试模拟），直接解析
interface RawResponsePayload {
  output?: unknown[]
  output_text?: string
  usage?: unknown
  tool_usage?: unknown
  error?: { message?: string; code?: string } | null
}

function extractResponseText(payload: RawResponsePayload | undefined): string {
  if (!payload) return ''
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    return payload.output_text
  }
  if (!Array.isArray(payload.output)) return ''
  let text = ''
  for (const item of payload.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        text += part.text
      }
    }
  }
  return text
}

// Responses 调用（看图）：图片放在最后；search 为真时带联网搜索，来源只取搜索工具返回的链接
export async function searchCall(
  meta: CallMeta & {
    instructions: string
    text: string
    imageDataUrl?: string
    timeoutMs?: number
    search?: boolean
    enableThinking?: boolean
    thinkingBudget?: number
    signal?: AbortSignal
  }
): Promise<SearchCallResult> {
  const t0 = Date.now()
  try {
    const content: unknown[] = [{ type: 'input_text', text: meta.text }]
    if (meta.imageDataUrl) {
      content.push({ type: 'input_image', image_url: meta.imageDataUrl })
    }
    const { data: stream, response } = (await getBailianClient().responses
      .create(
        {
          model: meta.model,
          instructions: meta.instructions,
          input: [{ role: 'user', content }],
          ...(meta.search === false ? {} : { tools: [{ type: 'web_search' }] }),
          enable_thinking: meta.enableThinking === true,
          ...(meta.enableThinking && meta.thinkingBudget ? { thinking_budget: meta.thinkingBudget } : {}),
          stream: true
        } as never,
        { timeout: meta.timeoutMs ?? BAILIAN_CONFIG.requestTimeoutMs, signal: meta.signal }
      )
      .withResponse()) as unknown as {
      data: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
      response: Response
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/json') && !response.bodyUsed) {
      const res = (await response.json()) as RawResponsePayload
      const usage = normalizeResponsesUsage(res.usage, res.tool_usage)
      await record(meta, usage, Date.now() - t0)
      return { text: extractResponseText(res), sources: collectSearchSources(res.output), usage }
    }

    let streamedText = ''
    let completed: RawResponsePayload | undefined
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        streamedText += event.delta
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        completed = event.response as unknown as RawResponsePayload
      } else if (event.type === 'response.failed') {
        const errInfo = (event.response as unknown as RawResponsePayload | undefined)?.error
        throw Object.assign(new Error(errInfo?.message || '云端看图请求失败'), { code: errInfo?.code })
      } else if (event.type === 'error') {
        throw Object.assign(new Error(event.message || '云端看图流异常'), { code: event.code ?? undefined })
      }
    }
    const usage = normalizeResponsesUsage(completed?.usage, completed?.tool_usage)
    await record(meta, usage, Date.now() - t0)
    const text = extractResponseText(completed) || streamedText
    return { text, sources: collectSearchSources(completed?.output), usage }
  } catch (err) {
    if (!meta.signal?.aborted) await record(meta, EMPTY_USAGE, Date.now() - t0, errorText(err))
    throw err
  }
}
