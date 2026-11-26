import { createHash } from 'node:crypto'
import type { AiPolicyVO } from '@shared/api'
import { BizError } from '../../common/bizError'
import { AI_SETTING_KEYS, EMBEDDING_CONFIG } from '../../config/cloudConfig'
import {
  findActivePreferences,
  replaceOrDeletePreference,
  reserveDailyEmbedding,
  sumCloudCachedTokens
} from '../../repositories/aiPolicyRepository'
import { countPendingEmbeddings } from '../../repositories/aiSearchRepository'
import { readSetting, upsertSettings } from '../../repositories/appSettingRepository'

const LIMIT = AI_SETTING_KEYS.embeddingDailyLimit
const COUNT = AI_SETTING_KEYS.embeddingDailyCount
// 首次使用由用户选择是否启用后台云端索引。正整数沿用旧版每日限额，-1 表示不限量。
const DEFAULT_LIMIT = 0
export const factBlockKey = (text: string) => AI_SETTING_KEYS.ruleBlockPrefix + createHash('sha256').update(text).digest('hex')

export function localDay(d = new Date()): string {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-')
}

export async function setEmbeddingLimit(limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < -1 || limit > 10000) throw new BizError('BAD_REQUEST', '每日限量可设为 1 至 10000 张')
  await upsertSettings([{ key: LIMIT, value: limit }])
}

export async function embeddingBudget(): Promise<'available' | 'paused' | 'exhausted'> {
  const limit = await readSetting<number>(LIMIT) ?? DEFAULT_LIMIT
  if (limit === 0) return 'paused'
  if (limit === -1) return 'available'
  const used = await readSetting<{ day: string; count: number }>(COUNT)
  return used?.day === localDay() && used.count >= limit ? 'exhausted' : 'available'
}

export async function resetOrganizeRules(): Promise<void> {
  await upsertSettings([{ key: AI_SETTING_KEYS.organizeRules, value: [] }])
}

// 云端请求开始前预留当日名额。遇到超时或程序退出仍计入工作量，次日自动重新计数。
export async function reserveEmbedding(day = localDay()): Promise<boolean> {
  return reserveDailyEmbedding(LIMIT, COUNT, day, DEFAULT_LIMIT)
}

export async function getAiPolicy(): Promise<AiPolicyVO> {
  const [pendingImages, rules, limit, count, localHits, cloudCachedTokens, preferences] = await Promise.all([
    countPendingEmbeddings(EMBEDDING_CONFIG.model),
    readSetting<unknown[]>(AI_SETTING_KEYS.organizeRules),
    readSetting<number>(LIMIT),
    readSetting<{ day: string; count: number }>(COUNT),
    readSetting<number>(AI_SETTING_KEYS.localHits),
    sumCloudCachedTokens(),
    findActivePreferences()
  ])
  return {
    pendingImages,
    confirmedFolders: rules?.length ?? 0,
    dailyLimit: limit ?? DEFAULT_LIMIT,
    dailyUsed: count?.day === localDay() ? count.count : 0,
    localHits: localHits ?? 0,
    cloudCachedTokens,
    preferences
  }
}

export async function changePreference(id: number, replacement: string | null): Promise<void> {
  if (!Number.isSafeInteger(id) || (replacement !== null && (typeof replacement !== 'string' || !replacement.trim() || replacement.trim().length > 300))) {
    throw new BizError('BAD_REQUEST', '偏好内容应为 1 至 300 个字')
  }
  await replaceOrDeletePreference(id, replacement, factBlockKey)
}
