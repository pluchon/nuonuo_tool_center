import { AI_CREDENTIAL_KEYS, type AiCredentialKey } from '@shared/settings'

// 百炼 OpenAI 兼容端点与默认模型（模型名以 /models 实际返回为准；以图搜图用 flash，max 单次要 1~3 分钟）
export const BAILIAN_CONFIG = {
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  visionSearchModel: 'qwen3.8-flash',
  // 对话、看图（多模态，base64 传图已实测可用）、做梦共用 flash，前缀才能共用缓存
  chatModel: 'qwen3.8-flash',
  requestTimeoutMs: 300_000,
  // 对话单次超时；看图和以图搜图用 requestTimeoutMs
  chatTimeoutMs: 60_000
} as const

// 语义向量：DashScope 原生多模态向量接口（兼容端点的 /models 里没有它），图片和中文查询在同一个空间，输出 1024 维
export const EMBEDDING_CONFIG = {
  url: 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding',
  model: 'qwen3-vl-embedding',
  dimension: 1024,
  timeoutMs: 30_000
} as const

// 模型单价（人民币，按华北 2 标准价）：供整理估算与用量统计共用
export const MODEL_PRICING = {
  chatInputPerMillionYuan: 0.8,
  chatOutputPerMillionYuan: 2.7,
  cachedInputDiscount: 0.2,
  batchDiscount: 0.5,
  webSearchPerCallYuan: 0.004,
  embedInputPerMillionYuan: 0.7
} as const

// 一键整理开始前的费用估算：按每张输入 2300、输出 300 Token 估算，实时按一次联网搜索估算，批量按半价估算
const ESTIMATED_LOOK_TOKEN_YUAN =
  (2300 * MODEL_PRICING.chatInputPerMillionYuan + 300 * MODEL_PRICING.chatOutputPerMillionYuan) / 1_000_000
export const ORGANIZE_COST = {
  tokensPerImage: 2600,
  realtimeYuanPerImage: ESTIMATED_LOOK_TOKEN_YUAN + MODEL_PRICING.webSearchPerCallYuan,
  batchYuanPerImage: ESTIMATED_LOOK_TOKEN_YUAN * MODEL_PRICING.batchDiscount,
  // 队列里前这么多张实时看，其余走批量（和看图队列一致）
  realtimeMax: 50
} as const

// AI 模块共用的持久化设置键
export const AI_SETTING_KEYS = {
  embeddingDailyLimit: 'ai.embedding.dailyLimit',
  embeddingDailyCount: 'ai.embedding.day',
  organizeRules: 'ai.organize.rules',
  organizeLegacyState: 'ai.organize',
  organizeLegacyLookFrom: 'ai.organizeLookFrom',
  dreamSummary: 'ai.dream.summary',
  lookSince: 'ai.lookSince',
  localHits: 'ai.localHits',
  ruleBlockPrefix: 'ai.ruleBlock.'
} as const

// 缓存命中率的检查：按文本 token 算（图片 token 每张都是新的，不计入），最近这么多次调用里低于目标时写警告
export const CACHE_HIT_CHECK = {
  target: 0.95,
  window: 20,
  minCalls: 10
} as const

export type CloudCredentials = Partial<Record<AiCredentialKey, string>>

export const CLOUD_ENV_NAMES: Record<AiCredentialKey, string> = {
  dashscopeApiKey: 'DASHSCOPE_API_KEY'
}

let userEnvironment: CloudCredentials = {}
let savedCredentials: CloudCredentials = {}
export function setUserEnvironmentCloudCredentials(credentials: CloudCredentials): void {
  userEnvironment = credentials
}

export function getSavedCloudCredentials(): CloudCredentials {
  return savedCredentials
}

export function setSavedCloudCredentials(credentials: CloudCredentials): void {
  savedCredentials = credentials
}

export function readEnvironmentCloudCredentials(env: NodeJS.ProcessEnv = process.env): CloudCredentials {
  const credentials: CloudCredentials = {}
  for (const key of AI_CREDENTIAL_KEYS) {
    const value = (env[CLOUD_ENV_NAMES[key]] ?? userEnvironment[key])?.trim()
    if (value) credentials[key] = value
  }
  return credentials
}

export function readCloudCredentials(): CloudCredentials {
  return { ...readEnvironmentCloudCredentials(), ...savedCredentials }
}
