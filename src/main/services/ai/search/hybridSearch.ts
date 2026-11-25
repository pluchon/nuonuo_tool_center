import { BAILIAN_CONFIG, EMBEDDING_CONFIG } from '../../../config/cloudConfig'
import { getLogger } from '../../../common/logger'
import { readCloudCredentials } from '../../../config/cloudConfig'
import { excludedImageIds } from '../../../repositories/aiMemoryRepository'
import { cachedSearchValue, searchCacheKey } from '../../../repositories/aiSearchCacheRepository'
import {
  countEmbeddings,
  findDirNames,
  findVocabulary,
  hasAnyImageInScope,
  hasSearchableImage,
  missingSearchVector,
  searchImages,
  type AiSearchFilter,
  type AiSearchHit
} from '../../../repositories/aiSearchRepository'
import { findCategories } from '../../../repositories/tagRepository'
import { RECENT_DAYS } from '../../galleryService'
import { chatCall } from '../bailianClient'
import { contrastDescriptions, IMAGE_MIN_SIMILARITY, semanticVector, uploadVector } from '../embeddingService'
import type { StoredAttachment } from '../assistantAttachment'
import type { CondLabel, DictTag, RoutedQuery, SearchSpec } from '../localRouter'
import type { MatchEvidence } from '../searchFeedback'
import { matchVisualFeatures, normalizeVisualTags } from './visualMatcher'

const log = getLogger('ai')

// 一次检索的结果：普通图（模型能看到）和 R-18 图（只在本地查，模型只知道数量）
export interface SearchOutcome {
  imageIds: number[]
  ordinaryIds: number[]
  evidence: MatchEvidence
  incomplete?: string
  alreadyShownCount?: number
  allAlreadyShown?: boolean
}

// 词典：标签（含分类名、别名）和目录名
export async function loadDictionary() {
  const [vocab, categories, dirs] = await Promise.all([findVocabulary(true), findCategories(), findDirNames()])
  const catName = new Map(categories.map((c) => [c.id, c.name]))
  return {
    tags: vocab.map((t) => ({ id: t.id, name: t.name, aliases: t.aliases, category: catName.get(t.categoryId) ?? '标签', general: t.general })),
    dirs
  }
}

// “怎么找的”那行字：不用“·”，条件之间用逗号
export function howText(conds: CondLabel[], found: number): string {
  const parts = conds.map(([k, v]) => `${k}「${v}」`).join('，')
  return `搜索了图库${parts ? `：${parts}` : ''}，找到 ${found} 张`
}

export function localReply(found: number): string {
  return found ? '' : '没找到符合条件的图片。'
}

export async function emptyScopeText(dirs: AiSearchFilter['dirs'], includeR18: boolean): Promise<string> {
  if (!includeR18 && (await hasSearchableImage(dirs, true))) {
    return '当前筛选条件下没有可检索的普通图片（该范围内仅有 R-18 图片，可打开 R-18 开关按已确认标签检索）。'
  }
  if (dirs?.length && (await hasAnyImageInScope(dirs, includeR18))) {
    return '当前类目录中的图片尚未确认标签或仍在待复核状态，暂时无法参与检索。'
  }
  return '当前范围内没有可检索的图片。请先将已确认标签、完成复核的图片归入类目录。'
}

export function ordinaryCardCaption(value: unknown, outcome: SearchOutcome): string | undefined {
  if (typeof value !== 'string' || !outcome.ordinaryIds.length || outcome.ordinaryIds.length !== outcome.imageIds.length) return
  const text = value.trim()
  if (!text || text.length > 90 || /[\r\n]|给用户看了|[0-9一二三四五六七八九十几]+\s*张|#\d|R[- ]?18|https?:\/\/|\.(?:png|jpe?g|webp|gif)\b/iu.test(text)) return
  return text
}

// 模型给的检索参数换成检索条件：每个词先按标签名和别名对，对不上的当关键词；同时解析通用视觉特征标签
export function specFromArgs(args: Record<string, unknown>, tags: DictTag[], query: string): { spec: SearchSpec; conds: CondLabel[] } {
  const requiredWords: string[] = []
  const spec: SearchSpec = { tagGroups: [], keywordGroups: [], requiredWords }
  const conds: CondLabel[] = []
  const byName = new Map<string, DictTag>()
  for (const t of tags) {
    for (const n of [t.name, ...t.aliases]) {
      byName.set(n.toLowerCase(), t)
    }
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 30) : '')
  // 专名和用户指定的标签是硬性条件，即便词表中没有也不能在向量检索时丢弃。
  const addWord = (word: string, label: string): void => {
    if (!word) return
    const t = byName.get(word.toLowerCase())
    if (t) {
      if (!spec.tagGroups.some((g) => g.includes(t.id))) {
        spec.tagGroups.push([t.id])
        conds.push([t.category || label, t.name])
      }
    } else if (!requiredWords.includes(word.toLowerCase())) {
      requiredWords.push(word.toLowerCase())
      conds.push([label, word])
    }
  }
  addWord(str(args.character), '角色')
  addWord(str(args.work), '作品')
  addWord(str(args.place), '地点')
  for (const group of Array.isArray(args.keywordGroups) ? args.keywordGroups.slice(0, 12) : []) {
    if (!Array.isArray(group)) continue
    const words = [...new Set(group.slice(0, 8).map((word) => str(word).toLowerCase()).filter(Boolean))]
    if (words.length) {
      spec.keywordGroups.push(words)
      conds.push(['关键词', words.join('、')])
    }
  }
  // 模型有时把同一画面条件同时写进 tags 和 keywordGroups。普通描述仍可通过画面命中。
  const visualWords = new Set(spec.keywordGroups.flat())
  for (const w of Array.isArray(args.tags) ? args.tags.slice(0, 5) : []) {
    const word = str(w)
    if (query.includes('标签') || !visualWords.has(word.toLowerCase())) addWord(word, '标签')
  }
  const visualInclude = normalizeVisualTags(args.visualInclude)
  if (visualInclude.length) {
    spec.visualInclude = visualInclude
    conds.push(['画面特征', visualInclude.join('、')])
  }
  const visualExclude = normalizeVisualTags(args.visualExclude)
  if (visualExclude.length) {
    spec.visualExclude = visualExclude
    conds.push(['排除特征', visualExclude.join('、')])
  }
  const ori = args.orientation
  if (ori === 'portrait' || ori === 'landscape' || ori === 'square') {
    spec.orientation = ori
    conds.push(['方向', { portrait: '竖图', landscape: '横图', square: '方图' }[ori]])
  }
  if (args.recent === true) {
    spec.recent = true
    conds.push(['时间', '最近导入'])
  }
  if (args.untagged === true) {
    spec.untagged = true
    conds.push(['状态', '还没打标签'])
  }
  return { spec, conds }
}

// 完整识别的自然查询保留专名、目录和方向约束。主题等画面条件还可以通过文字或视觉补充。
export function descriptiveSpec(route: RoutedQuery, tags: DictTag[]): SearchSpec {
  const spec: SearchSpec = { ...route.spec, tagGroups: [], keywordGroups: [...route.spec.keywordGroups] }
  for (const group of route.spec.tagGroups) {
    const terms = tags.filter((tag) => group.includes(tag.id))
    const words = terms.flatMap((tag) => [tag.name, ...tag.aliases].map((name) => name.toLowerCase()))
    if (terms.length && terms.every((tag) => !['角色', '作品', '画师', '地点', '人物'].includes(tag.category))) {
      spec.keywordGroups.push([...new Set(words)])
    } else {
      spec.tagGroups.push(group)
    }
  }
  return spec
}

// 本地已识别全部条件时，只向百炼索取画面描述、对照词与通用视觉特征，无需发送历史会话或图库资料。
export async function localVisualSupplement(
  query: string,
  callModel: typeof chatCall,
  searchTool: unknown
): Promise<{ text: string; vector: NonNullable<AiSearchFilter['vector']>; visualInclude?: string[]; visualExclude?: string[] } | undefined> {
  if (!(await countEmbeddings(EMBEDDING_CONFIG.model))) return
  try {
    const plan = await cachedSearchValue(
      searchCacheKey('local-visual-v1', [BAILIAN_CONFIG.chatModel, query]),
      (value): value is { text: string; contrast: string[]; visualInclude?: string[]; visualExclude?: string[] } =>
        !!value &&
        typeof value === 'object' &&
        'text' in value &&
        typeof value.text === 'string' &&
        'contrast' in value &&
        Array.isArray(value.contrast),
      async () => {
        if (!readCloudCredentials().dashscopeApiKey) return
        const { message } = await callModel({
          kind: 'chat',
          model: BAILIAN_CONFIG.chatModel,
          tools: [searchTool],
          messages: [
            {
              role: 'system',
              content:
                '调用 search_images。semantic 只描述用户指定的画面内容，contrast 提供一至两条最容易混淆的画面，保留主体，只改变关键特征；如有具体外观特征（如发色、耳形、眼镜、服饰），同时填写 visualInclude / visualExclude。目录、时间和标签约束已在本地处理。'
            },
            { role: 'user', content: query }
          ]
        })
        const call = message.tool_calls?.find((item) => item.type === 'function' && item.function.name === 'search_images')
        if (call?.type !== 'function') return
        const args = JSON.parse(call.function.arguments) as Record<string, unknown> | null
        const text = typeof args?.semantic === 'string' ? args.semantic.trim().slice(0, 100) : ''
        const contrast = contrastDescriptions(text, args?.contrast)
        const visualInclude = normalizeVisualTags(args?.visualInclude)
        const visualExclude = normalizeVisualTags(args?.visualExclude)
        if (text && contrast.length) {
          return {
            text,
            contrast,
            ...(visualInclude.length ? { visualInclude } : {}),
            ...(visualExclude.length ? { visualExclude } : {})
          }
        }
      }
    )
    if (!plan) return
    const vector = await semanticVector(plan.text, plan.contrast)
    if (vector) return { text: plan.text, vector, visualInclude: plan.visualInclude, visualExclude: plan.visualExclude }
  } catch (err) {
    log.warn('画面检索未完成，本轮保留已匹配的本地结果', err)
  }
}

// 通用混合检索：标签精确匹配优先，其次元数据关键词、WD 通用视觉特征与语义向量；R-18 只走本地字面路径
export async function runSearch(
  spec: SearchSpec,
  dirs: Array<{ rootId: number; prefix: string }> | undefined,
  includeR18: boolean,
  tags: DictTag[],
  semantic?: AiSearchFilter['vector'],
  candidateIds?: number[]
): Promise<SearchOutcome> {
  const requiredGroups = (spec.requiredWords ?? []).map((word) => [word])
  const base = {
    ids: candidateIds,
    tagGroups: spec.tagGroups,
    keywordGroups: [...requiredGroups, ...spec.keywordGroups],
    orientation: spec.orientation,
    recentDays: spec.recent ? RECENT_DAYS : undefined,
    untagged: spec.untagged,
    dirs
  }
  const visualInclude = spec.visualInclude ?? []
  const visualExclude = spec.visualExclude ?? []
  const hasVisualFilter = visualInclude.length > 0 || visualExclude.length > 0
  const hasKeywordFilter = spec.keywordGroups.length > 0
  const hasHardFilter =
    base.tagGroups.length > 0 || requiredGroups.length > 0 || !!base.orientation || !!base.recentDays || !!base.untagged
  const hasLiteral = hasHardFilter || hasKeywordFilter || (!semantic && !hasVisualFilter)

  const preferredTagGroups = base.keywordGroups.map((words) =>
    tags.filter((tag) => [tag.name, ...tag.aliases].some((name) => words.includes(name.toLowerCase()))).map((tag) => tag.id)
  )
  const empty: AiSearchHit = { ids: [], total: 0 }
  const normal = hasLiteral ? await searchImages({ ...base, preferredTagGroups, r18: 'exclude' }) : empty
  const protectedHits =
    includeR18 && hasLiteral
      ? await searchImages({
          ...base,
          preferredTagGroups,
          r18: 'only'
        })
      : empty

  const scopeFilter = { ...base, keywordGroups: requiredGroups }
  const visual = semantic ? await searchImages({ ...scopeFilter, r18: 'exclude', vector: semantic }) : empty

  let literalOrdinaryIds = normal.ids
  let featureMatches: number[] = []
  let visualHits = visual.ids
  let featureUnavailable = false
  let checkedMissingVectors = false

  if (hasVisualFilter) {
    const literalSet = new Set(normal.ids)
    // 如果同时给了关键词同义词（如「猫娘」与 cat_ears），已由文字直接确认的普通图无需再耗费推理，
    // 除非显式传了 visualExclude 需要复核排除条件。
    if (hasKeywordFilter) {
      const missingVec = Boolean(semantic && (await missingSearchVector(EMBEDDING_CONFIG.model, scopeFilter)))
      const poolIds =
        !semantic || missingVec
          ? [...new Set([...visual.ids, ...(await searchImages({ ...scopeFilter, r18: 'exclude' })).ids])]
          : visual.ids
      const toCheck = poolIds.filter((id) => !literalSet.has(id))
      const checked = await matchVisualFeatures(toCheck, { include: visualInclude, exclude: visualExclude })
      featureMatches = checked.matches
      featureUnavailable = checked.unavailable
      if (visualExclude.length) {
        const excludedCheck = await matchVisualFeatures(normal.ids, { include: [], exclude: visualExclude })
        const keep = new Set(excludedCheck.matches)
        literalOrdinaryIds = normal.ids.filter((id) => keep.has(id))
      }
      // 有显式视觉过滤条件时，未命中特征的纯语义候选不再直接放行，避免混淆特征（如狐耳/蝴蝶结）混入。
      visualHits = []
    } else {
      // 无关键词同义词（例如仅靠标签 + visualInclude，或纯 visualInclude/visualExclude）：对范围内普通图做严格视觉过滤
      const scopedCandidates = hasHardFilter
        ? normal.ids
        : (await searchImages({ ...scopeFilter, r18: 'exclude' })).ids
      const checked = await matchVisualFeatures(scopedCandidates, { include: visualInclude, exclude: visualExclude })
      featureMatches = checked.matches
      featureUnavailable = checked.unavailable
      literalOrdinaryIds = []
      // 如果语义检索命中且特征处于未判定（缺模型/超限），保留语义召回的未判定候选，但剔除明确不满足的候选
      if (semantic) {
        const uncheckedSet = new Set(checked.unchecked)
        visualHits = visual.ids.filter((id) => uncheckedSet.has(id))
        checkedMissingVectors = checked.unchecked.length > 0 && (await missingSearchVector(EMBEDDING_CONFIG.model, { ...scopeFilter, ids: checked.unchecked }))
      } else {
        visualHits = []
      }
    }
  }

  const ranked = [
    ...new Set([
      ...(hasKeywordFilter || !hasVisualFilter ? normal.tagMatchedIds ?? [] : []),
      ...(protectedHits.tagMatchedIds ?? []),
      ...literalOrdinaryIds,
      ...protectedHits.ids,
      ...featureMatches,
      ...visualHits
    ])
  ]
  const protectedIds = new Set(protectedHits.ids)
  const suppressed = await excludedImageIds()
  const imageIds = ranked.filter((id) => !suppressed.has(id))
  const literalIds = new Set([...literalOrdinaryIds, ...protectedHits.ids])
  const exact = new Set([...(hasKeywordFilter || !hasVisualFilter ? normal.tagMatchedIds ?? [] : []), ...(protectedHits.tagMatchedIds ?? [])])
  const featureSet = new Set(featureMatches)
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]))
  const tagConditions = [...base.tagGroups, ...preferredTagGroups]
    .map((g) => [...new Set(g.map((id) => tagNames.get(id)).filter(Boolean))].join('或'))
    .filter(Boolean)
  const methods: MatchEvidence['methods'] = {}
  for (const id of imageIds) {
    if (exact.has(id) && tagConditions.length) methods[id] = 'tag'
    else if (literalIds.has(id)) methods[id] = base.keywordGroups.length ? 'metadata' : 'filter'
    else if (featureSet.has(id)) methods[id] = 'feature'
    else methods[id] = 'vector'
  }
  const incomplete = featureUnavailable
    ? '部分候选图片暂时无法核对画面特征'
    : semantic && (!hasVisualFilter || checkedMissingVectors) && (await missingSearchVector(EMBEDDING_CONFIG.model, scopeFilter))
      ? '部分图片尚无画面向量'
      : undefined
  return { imageIds, ordinaryIds: imageIds.filter((id) => !protectedIds.has(id)), evidence: { methods, tagConditions }, incomplete }
}

// 按上传的图找相似的（只在有向量的普通图里找）
export async function searchByImage(
  image: Extract<StoredAttachment, { kind: 'image' }>,
  dirs: Array<{ rootId: number; prefix: string }> | undefined
): Promise<number[]> {
  const vec = await uploadVector(image.dataUrl, image.originalHash, dirs)
  const hit = await searchImages({
    tagGroups: [],
    keywordGroups: [],
    dirs,
    r18: 'exclude',
    vector: { values: vec, model: EMBEDDING_CONFIG.model, minSimilarity: IMAGE_MIN_SIMILARITY }
  })
  const suppressed = await excludedImageIds()
  return hit.ids.filter((id) => !suppressed.has(id))
}
