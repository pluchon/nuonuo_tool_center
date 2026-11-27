import { EMBEDDING_CONFIG } from '../../../../config/cloudConfig'
import { findTagNamesOf, hasSearchableImage } from '../../../../repositories/aiSearchRepository'
import { itemsOfImages } from '../../../galleryService'
import { contrastDescriptions, semanticVector } from '../../embeddingService'
import type { DictTag } from '../../localRouter'
import { emptyScopeText, ordinaryCardCaption, runSearch, specFromArgs } from '../../search/hybridSearch'
import { defineTool, isToolError, parseToolJson, truncateLabel } from '../toolRegistry'

const BRIEF_MAX = 8
const CLOSEST_TAGS_MAX = 6
const NO_MATCH_HINT = '没有直接命中的图，可以看看这些相近标签，或换个说法再试；如果还是 0 张，就用诺诺熟人拌嘴的大白话直接告诉用户，别用舞台腔。'

const ORIENTATION_LABEL: Record<string, string> = {
  portrait: '竖图',
  landscape: '横图',
  square: '方图'
}

function formatSearchStart(args: Record<string, unknown>): string {
  const parts: string[] = []
  const push = (val: unknown, maxChars = 14): void => {
    const text = truncateLabel(val, maxChars)
    if (text && !parts.includes(text)) parts.push(text)
  }
  push(args.character)
  push(args.work)
  push(args.place)
  if (Array.isArray(args.tags)) {
    for (const t of args.tags) push(t)
  }
  if (Array.isArray(args.keywordGroups)) {
    for (const group of args.keywordGroups) {
      if (Array.isArray(group) && group.length > 0) push(group[0])
    }
  }
  if (parts.length < 3 && Array.isArray(args.visualInclude)) {
    for (const v of args.visualInclude) {
      if (parts.length >= 3) break
      push(v)
    }
  }
  if (typeof args.orientation === 'string' && ORIENTATION_LABEL[args.orientation]) {
    push(ORIENTATION_LABEL[args.orientation])
  }
  if (args.recent === true) push('最近导入')
  if (args.onlyR18 === true) push('R-18')
  if (parts.length < 2) push(args.semantic, 12)

  const summary = parts.slice(0, 3).join('、')
  if (summary) {
    return args.excludeShown === true ? `检索图库：换一批（${summary}）` : `检索图库：${summary}`
  }
  if (args.excludeShown === true) return '检索图库：换一批'
  if (args.browseScope === true) return '检索图库：浏览目录'
  return '检索图库'
}

function normalizeTerm(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, '').trim()
}

function multisetDice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const counts = new Map<string, number>()
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1)
  let overlap = 0
  for (const item of b) {
    const left = counts.get(item) ?? 0
    if (left > 0) {
      overlap++
      counts.set(item, left - 1)
    }
  }
  return (2 * overlap) / (a.length + b.length)
}

function bigramsOf(text: string): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length - 1; i++) {
    out.push(chars[i] + chars[i + 1])
  }
  return out
}

function termTagSimilarity(term: string, candidate: string): number {
  const a = normalizeTerm(term)
  const b = normalizeTerm(candidate)
  if (!a || !b) return 0
  if (a === b) return 1
  const charsA = Array.from(a)
  const charsB = Array.from(b)
  let subScore = 0
  if (a.includes(b) || b.includes(a)) {
    const minLen = Math.min(charsA.length, charsB.length)
    const maxLen = Math.max(charsA.length, charsB.length)
    const base = minLen >= 2 ? 0.6 : 0.35
    subScore = base + (1 - base) * (minLen / maxLen)
  }
  const bigramDice = multisetDice(bigramsOf(a), bigramsOf(b))
  const charDice = multisetDice(charsA, charsB)
  return Math.max(subScore, 0.75 * bigramDice + 0.25 * charDice)
}

function collectQueryTerms(args: Record<string, unknown>): { allTerms: string[]; tagLikeTerms: string[] } {
  const tagLikeTerms: string[] = []
  const allTerms: string[] = []
  const add = (val: unknown, isTagLike: boolean): void => {
    const text = typeof val === 'string' ? val.trim() : ''
    if (!text) return
    if (!allTerms.includes(text)) allTerms.push(text)
    if (isTagLike && !tagLikeTerms.includes(text)) tagLikeTerms.push(text)
  }
  add(args.character, true)
  add(args.work, true)
  add(args.place, true)
  if (Array.isArray(args.tags)) {
    for (const t of args.tags) add(t, true)
  }
  if (Array.isArray(args.keywordGroups)) {
    for (const group of args.keywordGroups) {
      if (Array.isArray(group)) {
        for (const w of group) add(w, false)
      }
    }
  }
  add(args.semantic, false)
  return { allTerms, tagLikeTerms }
}

function findClosestTags(
  args: Record<string, unknown>,
  tags: Array<DictTag & { general: boolean }>,
  includeR18: boolean
): string[] {
  const { allTerms, tagLikeTerms } = collectQueryTerms(args)
  if (!allTerms.length) return []

  const visibleTags = tags.filter((t) => includeR18 || t.general)
  if (!visibleTags.length) return []

  const exactLookup = new Set<string>()
  for (const tag of visibleTags) {
    exactLookup.add(tag.name.toLowerCase())
    for (const alias of tag.aliases) exactLookup.add(alias.toLowerCase())
  }

  const missingTerms = allTerms.filter((t) => !exactLookup.has(t.toLowerCase()))
  if (!missingTerms.length) return []

  const queriedTagSet = new Set(tagLikeTerms.map((t) => t.toLowerCase()))
  const scored: Array<{ name: string; score: number }> = []
  for (const tag of visibleTags) {
    const names = [tag.name, ...tag.aliases]
    if (names.some((n) => queriedTagSet.has(n.toLowerCase()))) continue
    let best = 0
    for (const term of missingTerms) {
      for (const candidate of names) {
        const s = termTagSimilarity(term, candidate)
        if (s > best) best = s
      }
    }
    if (best >= 0.1) {
      scored.push({ name: tag.name, score: best })
    }
  }

  scored.sort((a, b) => b.score - a.score || Array.from(a.name).length - Array.from(b.name).length)
  return scored.slice(0, CLOSEST_TAGS_MAX).map((item) => item.name)
}

export const searchImagesTool = defineTool({
  name: 'search_images',
  description: '在本地图库里找图。范围和是否包含 R-18 由软件按用户的选择决定，不用你传。返回总数和前几张的编号、名字、标签。',
  sideEffect: 'read',
  formatStart: formatSearchStart,
  formatDone(args, result) {
    const start = formatSearchStart(args)
    if (result.outcome?.type === 'awaiting_contrast') return `${start} · 需补充对照`
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    if (isToolError(parsed)) return `${start} · 未执行`
    if (parsed?.allAlreadyShown === true) return `${start} · 暂无新图`
    if (typeof parsed?.total === 'number') return `${start} · ${parsed.total} 张`
    return start
  },
  parameters: {
    type: 'object',
    required: ['contrast'],
    // 兼容部分检索省略 contrast 的调用，缺失时由执行逻辑触发 awaitingContrast 补问或纯本地筛选
    runtimeRequired: [],
    properties: {
      character: { type: 'string', description: '角色名' },
      work: { type: 'string', description: '作品名（游戏、动画、漫画等）' },
      place: { type: 'string', description: '地点' },
      tags: { type: 'array', items: { type: 'string' }, description: '其他标签，如主题、风格' },
      keywordGroups: {
        type: 'array',
        items: { type: 'array', items: { type: 'string' } },
        description: '每一组都是必须满足的画面特征，组内只填写意思相同的表述'
      },
      visualInclude: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string' },
        description: '可选。需要画面中必须具备的英文 Danbooru 视觉特征标签，如 ["blue_hair","1girl"]、["cat_ears"]、["glasses"]'
      },
      visualExclude: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string' },
        description: '可选。需要从画面中排除的英文 Danbooru 视觉特征标签，如 ["fox_ears"]、["headphones"]'
      },
      orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'], description: '竖图、横图、方图' },
      recent: { type: 'boolean', description: '只要最近 30 天导入的' },
      onlyR18: {
        type: 'boolean',
        description: '可选。仅在用户已开启“包含 R-18”且明确只想看 R-18 图片时设为 true；未开启“包含 R-18”时严禁设为 true。'
      },
      browseScope: { type: 'boolean', description: '用户已选定某个类目录并想直接列出或浏览其中图片时设为 true。' },
      excludeShown: {
        type: 'boolean',
        description: '当用户说“还有其他的吗”“换几张”“看过了”“再找别的”等想看没展示过的图时设为 true，自动排除本段对话已经展示过的图片。'
      },
      excludeIds: {
        type: 'array',
        items: { type: 'integer' },
        maxItems: 50,
        description: '要额外排除的图片编号。'
      },
      answerFromResults: { type: 'boolean', description: '用户明确要求根据检索结果比较、解读或按指定格式回答时设为 true。只找图时省略。' },
      onMatch: {
        type: 'string',
        description: '可选。确实找到图时随卡片说的一句自然口语短句（像熟人拌嘴/小恶魔损两句，别用“本小姐”或舞台腔）。不要提前描述图片、统计数量或复述条件。'
      },
      semantic: { type: 'string', description: '一句话的画面描述，按画面相似度再找一路' },
      contrast: {
        type: 'array',
        maxItems: 2,
        items: { type: 'string' },
        description: '提供 semantic 时必填一至两个反例。优先同一类别内最易混淆的特征，不可重复正例或给出相距很远的场景。没有画面描述时填 []。'
      }
    }
  },
  async execute(rawArgs, env, state) {
    const pending = state.awaitingContrast
    const args = pending ? { ...pending, contrast: rawArgs.contrast } : rawArgs
    if (args.onlyR18 === true && !env.includeR18) {
      return {
        content: JSON.stringify({
          total: 0,
          images: [],
          r18SwitchOff: true,
          hint: '当前未开启“包含 R-18”开关，看不到也不检索 R-18 图片；直接用诺诺口吻提醒用户先打开输入框下方的 R-18 开关就行，绝不编造任何 R-18 图片。'
        }),
        outcome: { type: 'none' }
      }
    }
    const visibleTags = env.tags.filter((t) => env.includeR18 || t.general)
    const { spec, conds } = specFromArgs(args, visibleTags, env.query)
    if (args.onlyR18 === true && env.includeR18) {
      spec.onlyR18 = true
      conds.push(['分级', 'R-18'])
    }
    const semanticText = typeof args.semantic === 'string' ? args.semantic.trim().slice(0, 100) : ''
    if (semanticText && !pending && !contrastDescriptions(semanticText, args.contrast).length) {
      return {
        content: JSON.stringify({ error: '画面检索缺少有效的 contrast。请重新调用 search_images，只补充一至两条最容易混淆的相似画面，保留原有条件。' }),
        outcome: { type: 'awaiting_contrast', args }
      }
    }
    const semantic = spec.onlyR18 ? undefined : await semanticVector(semanticText, args.contrast)
    // 即使普通图可按向量检索，画面描述也要参与本地元数据匹配，覆盖无向量和 R-18 图片。
    if (semanticText && !spec.keywordGroups.length && !spec.visualInclude?.length) {
      spec.keywordGroups.push([semanticText.toLowerCase()])
      if (!semantic) conds.push(['关键词', semanticText])
    }
    const literal =
      spec.tagGroups.length > 0 ||
      spec.keywordGroups.length > 0 ||
      !!spec.requiredWords?.length ||
      !!spec.visualInclude?.length ||
      !!spec.visualExclude?.length ||
      !!spec.orientation ||
      !!spec.recent ||
      !!spec.untagged ||
      !!spec.onlyR18
    const canBrowseScope = Boolean(env.selectedCategory) || (args.browseScope === true && Boolean(env.dirs?.length))
    if (!literal && !semantic && !canBrowseScope) {
      return {
        content: JSON.stringify({ error: '没有可用的检索条件，请给出标签、关键词或画面描述' }),
        outcome: { type: 'none' }
      }
    }
    let candidates = env.candidateIds
    if (env.modelReferences) {
      const allowed = new Set(env.modelReferences.map((ref) => ref.imageId))
      candidates = candidates ? candidates.filter((id) => allowed.has(id)) : [...allowed]
    }
    const outcome = await runSearch(spec, env.dirs, env.includeR18, visibleTags, semantic, candidates, env.includeOrganized)
    if (semanticText && !semantic && (await hasSearchableImage(env.dirs, false, env.includeOrganized))) {
      outcome.incomplete ??= '画面相似度检索暂不可用'
    }
    const excludeSet = new Set<number>()
    if (args.excludeShown === true && env.shownImages?.length) {
      for (const img of env.shownImages) {
        excludeSet.add(img.id)
      }
    }
    if (Array.isArray(args.excludeIds)) {
      for (const id of args.excludeIds) {
        if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
          excludeSet.add(id)
        }
      }
    }
    const beforeCount = outcome.imageIds.length
    if (excludeSet.size > 0 && beforeCount > 0) {
      outcome.imageIds = outcome.imageIds.filter((id) => !excludeSet.has(id))
      outcome.ordinaryIds = outcome.ordinaryIds.filter((id) => !excludeSet.has(id))
    }
    const alreadyShownCount = beforeCount - outcome.imageIds.length
    const allAlreadyShown = beforeCount > 0 && outcome.imageIds.length === 0
    if (alreadyShownCount > 0) {
      outcome.alreadyShownCount = alreadyShownCount
    }
    if (allAlreadyShown) {
      outcome.allAlreadyShown = true
    }
    // 语气属于当前对话，不随可复用的检索条件一起缓存。受保护的图片只使用本地卡片文案。
    const { onMatch, ...plan } = args
    const hasSessionDedup = args.excludeShown === true || (Array.isArray(args.excludeIds) && args.excludeIds.length > 0)
    const cacheablePlan = !hasSessionDedup && (!semanticText || semantic) ? plan : undefined
    const finalConds = semantic ? [...conds, ['画面', semanticText] as [string, string]] : conds
    const caption = ordinaryCardCaption(onMatch, outcome)
    const brief = (env.includeR18 ? outcome.imageIds : outcome.ordinaryIds).slice(0, BRIEF_MAX)
    const tagNames = await findTagNamesOf(brief)
    const items = await itemsOfImages(brief, env.includeR18, env.dirs, env.includeOrganized)
    const total = env.includeR18 ? outcome.imageIds.length : outcome.ordinaryIds.length
    const scopeEmpty = total === 0 && !allAlreadyShown && !(await hasSearchableImage(env.dirs, env.includeR18, env.includeOrganized))
    const closestTags = total === 0 && !allAlreadyShown && !scopeEmpty ? findClosestTags(args, env.tags, env.includeR18) : []
    const scopeReason = scopeEmpty ? await emptyScopeText(env.dirs, env.includeR18, env.includeOrganized) : undefined
    return {
      content: JSON.stringify({
        total,
        images: items.map((i) => ({
          id: i.imageId,
          name: i.name,
          tags: tagNames.get(i.imageId) ?? [],
          ...(i.isR18 ? { isR18: true } : {})
        })),
        ...(env.includeR18 ? { r18Total: outcome.imageIds.length - outcome.ordinaryIds.length } : {}),
        alreadyShownCount,
        allAlreadyShown,
        ...(scopeEmpty
          ? {
              scopeEmpty: true,
              scopeReason,
              hint: '当前可检索范围为空（还没有已确认标签的可用图片），不必反复换词重搜；直接用诺诺熟人斗嘴般的自然口语告诉用户原因并轻快提醒就行，别用舞台腔。'
            }
          : {}),
        ...(closestTags.length > 0 ? { closestTags, hint: NO_MATCH_HINT } : {})
      }),
      outcome: {
        type: 'search',
        outcome,
        conds: finalConds,
        caption,
        needsDetails: args.answerFromResults === true || allAlreadyShown,
        cacheablePlan
      }
    }
  }
})
