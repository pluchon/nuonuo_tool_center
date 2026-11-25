import { matchCachedVisualFeatures } from '../../../repositories/aiSearchRepository'
import { FEATURE_REVISION, getVisualTagsForSearch } from '../../rating/ratingService'

export interface VisualFilterSpec {
  include: string[]
  exclude?: string[]
  ambiguous?: string[]
  maxInspect?: number
}

const VALID_VISUAL_TAG = /^[a-z0-9_+()-]{1,48}$/
const DEFAULT_MAX_INSPECT = 8
const MAX_VISUAL_TAGS = 8

// 清洗 AI 输出的 Danbooru 视觉标签：小写、空白转下划线、校验字符集并去重
export function normalizeVisualTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().toLowerCase().replace(/\s+/g, '_')
    if (!tag || !VALID_VISUAL_TAG.test(tag) || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= MAX_VISUAL_TAGS) break
  }
  return out
}

// 纯函数判断一张图的视觉标签集合是否满足条件；命中 ambiguous 返回 null 表示待定
export function evaluateVisualTags(tags: string[], spec: VisualFilterSpec): boolean | null {
  const set = new Set(tags)
  if (!spec.include.every((t) => set.has(t))) return false
  if (spec.exclude?.some((t) => set.has(t))) return false
  if (spec.ambiguous?.some((t) => set.has(t))) return null
  return true
}

// 通用视觉特征匹配：优先读取 PG 中已缓存的 WD 标签，缺少特征的候选按上限补跑本地模型
export async function matchVisualFeatures(
  candidateIds: number[],
  spec: VisualFilterSpec,
  priorityIds?: number[]
): Promise<{ matches: number[]; unchecked: number[]; unavailable: boolean }> {
  const exclude = spec.exclude ?? []
  const ambiguous = spec.ambiguous ?? []
  if (!candidateIds.length || (!spec.include.length && !exclude.length)) {
    return { matches: [], unchecked: [], unavailable: false }
  }
  const cached = await matchCachedVisualFeatures(candidateIds, FEATURE_REVISION, spec.include, exclude, ambiguous)
  const known = new Map<number, boolean | null>(cached.map((row) => [row.id, row.matches]))
  const missing = candidateIds.filter((id) => !known.has(id))
  const limit = spec.maxInspect ?? DEFAULT_MAX_INSPECT
  let ordered = missing
  if (priorityIds?.length && missing.length > limit) {
    const prioritySet = new Set(priorityIds)
    ordered = [...missing.filter((id) => prioritySet.has(id)), ...missing.filter((id) => !prioritySet.has(id))]
  }
  const toInspect = ordered.slice(0, limit)
  let unavailable = false
  for (const id of toInspect) {
    const tags = await getVisualTagsForSearch(id)
    if (!tags) {
      unavailable = true
      continue
    }
    known.set(id, evaluateVisualTags(tags, spec))
  }
  return {
    matches: candidateIds.filter((id) => known.get(id) === true),
    unchecked: candidateIds.filter((id) => known.get(id) == null),
    unavailable
  }
}
