// 把百炼两种接口返回的用量统一成一种结构，字段名以实测返回为准（2026-11-22）

// 调用类型：chat 对话、look 看图、dream 做梦、translate 翻译词表、identify 以图搜图、embed 语义向量、organize 一键整理出方案
export type ApiKind = 'chat' | 'look' | 'dream' | 'translate' | 'identify' | 'embed' | 'organize'

// 计入缓存命中率目标的调用类型
export const HIT_RATE_KINDS: ApiKind[] = ['chat', 'look']

// 统一后的一次调用用量
export interface NormalizedUsage {
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  imageTokens: number
  outputTokens: number
  searchCount: number
}

// 取数字字段，缺失或不是数字时当 0
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// 取对象字段，不是对象时返回空对象
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

// Chat Completions：prompt_tokens 含命中部分；写入数在 prompt_tokens_details.cache_creation_input_tokens
export function normalizeChatUsage(usage: unknown): NormalizedUsage {
  const u = obj(usage)
  const d = obj(u.prompt_tokens_details)
  return {
    inputTokens: num(u.prompt_tokens),
    cachedTokens: num(d.cached_tokens),
    cacheWriteTokens: num(d.cache_creation_input_tokens),
    imageTokens: num(d.image_tokens),
    outputTokens: num(u.completion_tokens),
    searchCount: 0
  }
}

// Responses：input_tokens 含命中部分；图片 token 在 x_details，联网搜索次数在 x_tools.web_search.count
export function normalizeResponsesUsage(usage: unknown): NormalizedUsage {
  const u = obj(usage)
  const d = obj(u.input_tokens_details)
  const details = Array.isArray(u.x_details) ? u.x_details : []
  const imageTokens = details.reduce((sum: number, x) => sum + num(obj(obj(x).input_tokens_details).image_tokens), 0)
  return {
    inputTokens: num(u.input_tokens),
    cachedTokens: num(d.cached_tokens),
    cacheWriteTokens: num(d.cache_write_tokens),
    imageTokens,
    outputTokens: num(u.output_tokens),
    searchCount: num(obj(obj(u.x_tools).web_search).count)
  }
}

// 文本 token 的缓存命中率：图片 token 每张都是新的，不计入分母；没有文本输入时返回 null
export function textHitRate(rows: Array<Pick<NormalizedUsage, 'inputTokens' | 'cachedTokens' | 'imageTokens'>>): number | null {
  let text = 0
  let cached = 0
  for (const r of rows) {
    text += Math.max(0, r.inputTokens - r.imageTokens)
    cached += r.cachedTokens
  }
  return text > 0 ? Math.min(1, cached / text) : null
}
