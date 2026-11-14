// 云端配置：凭证只从环境变量读取，不落库、不写日志；非机密参数集中在这里
export const OSS_CONFIG = {
  region: 'oss-cn-guangzhou',
  bucket: 'zlhimage',
  tempPrefix: 'local_image_temp/',
  signedUrlTtlSeconds: 600
} as const

// 百炼 OpenAI 兼容端点与默认模型（模型名以 /models 实际返回为准）
export const BAILIAN_CONFIG = {
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  visionSearchModel: 'qwen3.8-max',
  requestTimeoutMs: 300_000
} as const

// 云端凭证
export interface CloudCredentials {
  dashscopeApiKey?: string
  aliyunAccessKeyId?: string
  aliyunAccessKeySecret?: string
}

// 读取环境变量中的云端凭证，缺失的字段保持 undefined
export function readCloudCredentials(env: NodeJS.ProcessEnv = process.env): CloudCredentials {
  return {
    dashscopeApiKey: env.DASHSCOPE_API_KEY || undefined,
    aliyunAccessKeyId: env.ALIYUN_ACCESS_KEY_ID || undefined,
    aliyunAccessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET || undefined
  }
}
