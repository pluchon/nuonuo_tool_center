import { AI_CONTEXT_WINDOW, type AiContextUsage } from '@shared/api'
import { BizError } from '../../common/bizError'
import type { PromptMessage } from './promptPrefix'
import type { NormalizedUsage } from './usage'

const OUTPUT_RESERVE = 8_192
const MODEL_MAX_OUTPUT = 131_072

// 百炼返回实际用量前，以 UTF-8 字节数保守估算文本，并给协议封装留出余量。
// 传给对话模型的图片已经缩至长边 512 像素，base64 字符串不作为文本计数。
export function messageBound(message: PromptMessage): number {
  const text = typeof message.content === 'string'
    ? Buffer.byteLength(message.content)
    : message.content.reduce((total, part) => total + (part.type === 'text' ? Buffer.byteLength(part.text) : 1024) + 16, 0)
  return 32 + text + Buffer.byteLength(message.tool_call_id ?? '') + Buffer.byteLength(JSON.stringify(message.tool_calls ?? []))
}

// prefix、tail 包含固定提示和当前工具往返。过长时只移除完整的旧轮次，保留最近的连续历史。
export function fitContext(prefix: PromptMessage[], history: PromptMessage[], tail: PromptMessage[], tools?: unknown[]) {
  let inputBound = 512 + Buffer.byteLength(JSON.stringify(tools ?? []))
  for (const message of [...prefix, ...tail]) inputBound += messageBound(message)
  const inputLimit = AI_CONTEXT_WINDOW - OUTPUT_RESERVE
  if (inputBound > inputLimit) throw new BizError('BAD_REQUEST', '本轮提示和附件超过 475K 上下文窗口')

  let keepFrom = history.length
  let turnBound = 0
  for (let i = history.length - 1; i >= 0; i--) {
    turnBound += messageBound(history[i])
    if (inputBound + turnBound > inputLimit) break
    if (history[i].role === 'user') {
      inputBound += turnBound
      keepFrom = i
      turnBound = 0
    }
  }
  const outputRoom = AI_CONTEXT_WINDOW - inputBound
  return {
    messages: [...prefix, ...history.slice(keepFrom), ...tail],
    inputBound,
    // 正常短对话沿用服务默认值，接近窗口上限时才限制生成长度。
    maxTokens: outputRoom < MODEL_MAX_OUTPUT ? outputRoom : undefined
  }
}

export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3000 && cp <= 0x30ff) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk * 0.72 + other * 0.28)
}

export function estimatePromptTokens(messages: readonly PromptMessage[], tools?: unknown[]): number {
  let total = tools?.length ? estimateTextTokens(JSON.stringify(tools)) : 0
  for (const m of messages) {
    total += 8
    if (typeof m.content === 'string') {
      total += estimateTextTokens(m.content)
    } else {
      for (const part of m.content) {
        total += part.type === 'text' ? estimateTextTokens(part.text) : 256
      }
    }
    if (m.tool_call_id) total += estimateTextTokens(m.tool_call_id)
    if (m.tool_calls?.length) total += estimateTextTokens(JSON.stringify(m.tool_calls))
  }
  return Math.max(1, total)
}

export function contextUsage(usage: NormalizedUsage | undefined, inputBound: number, output: unknown): AiContextUsage {
  if (usage && usage.inputTokens > 0) {
    return { usedTokens: usage.inputTokens + (usage.outputTokens || 0), estimated: false }
  }
  return { usedTokens: inputBound + Buffer.byteLength(JSON.stringify(output) ?? ''), estimated: true }
}
