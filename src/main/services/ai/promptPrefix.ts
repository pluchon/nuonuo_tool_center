// 组装请求消息：所有调用共用同一个前缀，按稳定程度排成四层，缓存标记只打在 ①② 和 ③ 末尾（见设计 6.8）

// 显式缓存标记
export const CACHE_MARK = { type: 'ephemeral' } as const

// 消息里的一段内容：文字或图片（图片用 data URL 或公网 URL）
export type ContentPart =
  | { type: 'text'; text: string; cache_control?: typeof CACHE_MARK }
  | { type: 'image_url'; image_url: { url: string }; cache_control?: typeof CACHE_MARK }

// 发给模型的一条消息（OpenAI 兼容格式的子集）
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  reasoning_content?: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

// 四层前缀的原料
export interface PrefixParts {
  // ① 固定规则和所有输出格式，只在应用升级时变
  rules: string
  // ② 核心档案和标签词表快照（已序列化），最多一天变一次；对话锁定开始时的版本
  profile: string
  // ③ 这段对话的历史，只往后追加
  history: PromptMessage[]
  // ④ 每次都变的内容：当前时间、检索到的记忆、这句话或这张图，永远放最后
  tail: PromptMessage[]
  // 预计 5 分钟内还会再调用时才打显式标记，只调一次的走隐式缓存
  cache: boolean
}

// 一个请求最多 4 个缓存标记；基础前缀用 2 个，其余留给多步工具循环推进断点
const MAX_MARKS = 4

// 键名按字典序排好再序列化，同样的数据永远得到同样的文本，前缀才不会因为键序抖动而失效
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

// 递归排序对象键；数组保持原顺序
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

// 给一条消息的最后一段内容打上缓存标记；字符串内容转成单段文字（tool 消息保持纯文本）
function withMark(message: PromptMessage): PromptMessage {
  if (message.role === 'tool') {
    return message
  }
  const parts: ContentPart[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...message.content]
  if (parts.length === 0) {
    return message
  }
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: CACHE_MARK }
  return { ...message, content: parts }
}

// 按 ①②③④ 的顺序拼出消息；①② 合成一条 system，③ 原样接上，④ 放最后且永不打标记
export function buildMessages(parts: PrefixParts): PromptMessage[] {
  const systemText = parts.profile ? `${parts.rules}\n\n${parts.profile}` : parts.rules
  const system: PromptMessage = { role: 'system', content: [{ type: 'text', text: systemText }] }
  const history = [...parts.history]
  const messages: PromptMessage[] = []
  if (parts.cache) {
    messages.push(withMark(system))
    if (history.length > 0) {
      history[history.length - 1] = withMark(history[history.length - 1])
    }
  } else {
    messages.push(system)
  }
  messages.push(...history, ...parts.tail)
  return messages
}

// 数一下消息里的缓存标记，调用前自检用
export function countCacheMarks(messages: PromptMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      n += m.content.filter((p) => p.cache_control).length
    }
  }
  return n
}

// 标记数超过上限说明前缀拼错了，直接报错，不发请求
export function assertCacheMarks(messages: PromptMessage[]): void {
  const n = countCacheMarks(messages)
  if (n > MAX_MARKS) {
    throw new Error(`缓存标记 ${n} 个，超过上限 ${MAX_MARKS}`)
  }
}

// 多步工具循环时，在还有可用断点额度的前提下推进缓存断点（仅标定未标记的 user 消息，tool 消息保持纯文本以对齐百炼显式缓存规范）
export function markStepCache(messages: PromptMessage[]): PromptMessage[] {
  if (countCacheMarks(messages) >= MAX_MARKS) {
    return messages
  }
  const hasMark = (m: PromptMessage): boolean => Array.isArray(m.content) && m.content.some((p) => p.cache_control)
  const userIdx = messages.findLastIndex((m) => m.role === 'user' && !hasMark(m))
  if (userIdx >= 0) {
    const next = [...messages]
    next[userIdx] = withMark(messages[userIdx])
    return next
  }
  return messages
}
