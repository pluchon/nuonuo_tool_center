import { EMBEDDING_CONFIG } from '../../../config/cloudConfig'
import { hasSearchableImage, missingSearchVector, type AiSearchFilter } from '../../../repositories/aiSearchRepository'
import { SEARCH_IMAGES_TOOL } from './tools'
import { SEARCH_CACHE_TTL } from '../../../repositories/aiSearchCacheRepository'
import type { AiMessageEntity } from '../../../repositories/aiConversationRepository'
import type { StoredAttachment } from '../assistantAttachment'
import type { chatCall } from '../bailianClient'
import { prepareCategoryRequest, restorePreparedProposal } from '../categoryProposalService'
import { classifyCloudError } from '../cloudErrors'
import { filterReferenceIds, referencedHistory, resolveReferenceQuery } from '../assistantReferences'
import { routeLocally, routeTagRequest, type CondLabel, type DictDir, type DictTag } from '../localRouter'
import { resultFollowup } from '../searchFeedback'
import { descriptiveSpec, emptyScopeText, howText, localReply, localVisualSupplement, runSearch, searchByImage } from '../search/hybridSearch'
import { directoryFeedback, type AssistantContent, type UserContent } from './types'

// 从明显找图指令中剥离出检索关键词，供空范围检查与离线降级检索使用
const SEARCH_PREFIX_RE =
  /^(?:(?:请问|麻烦|请|可以|能不能|能|你|帮我|给我|替我|我想|我要|我想要|我|再|重新|继续|在图库里)\s*)*(?:想看看|想看|搜索|检索|查找|搜搜|搜一下|搜|找找|找一下|找)\s*/u

export function requestedSearch(text: string): string | null {
  const query = text.trim()
  const question = /^(?:有没有|有无|给我看看)\s*(.+?)(?:的)?(?:图片|插画|照片|壁纸|图)(?:吗|呢)?[？！?!。]*$/u.exec(query)
  if (question) return question[1].trim()
  if (!SEARCH_PREFIX_RE.test(query)) return null
  return query.replace(SEARCH_PREFIX_RE, '').replace(/(?:的(?:图片|照片|图)|[？！?!。])+$/u, '').trim() || query
}

// “这些图里”明确限定在最近一轮结果；单独输入另一种特征仍检索当前完整范围。
export function followupQuery(text: string): string | undefined {
  return /^(?:请|帮我)?(?:在|从)?(?:刚才|上次|上轮|上一轮)?(?:的)?(?:这几张|这些|刚才的|上次的)(?:图片|插画|图|结果)?(?:里面|里|中)(?:面)?[，,\s]*(?:筛选|找找|找出|只看|想看|看看|找|看|有)?\s*(.+)$/u
    .exec(text.trim())?.[1]
    ?.replace(/(?:的图|吗|呢|[？?！!。])+$/u, '')
    .trim()
}

export interface FastPathInput {
  user: AiMessageEntity
  history: AiMessageEntity[]
  attachments: StoredAttachment[]
  dirs: AiSearchFilter['dirs']
  scopeName: string | null
  scopeConds: CondLabel[]
  dict: { tags: Array<DictTag & { general: boolean }>; dirs: DictDir[] }
  cloudReady: boolean
  callModel: typeof chatCall
  visibleForTurn: (ids: number[], source?: number) => Promise<Set<number>>
}

export interface FastPathResult {
  content?: AssistantContent
  candidateIds?: number[]
  reference?: Awaited<ReturnType<typeof resolveReferenceQuery>>
  hasInputContext: boolean
  query: string
  refinement?: string
}

// 确定性零成本快路径：只拦截 100% 明确的指令（结果追问、引用读取、显式提案、纯以图搜图、精确标签/字典直查、空范围保护和离线降级）
export async function tryFastPath(input: FastPathInput): Promise<FastPathResult> {
  const { user, history, attachments, dirs, scopeName, scopeConds, dict, cloudReady, callModel, visibleForTurn } = input
  const u = user.content as UserContent

  const followup = attachments.length ? null : await resultFollowup(u.text, u.references ?? [], history, user.id, visibleForTurn)
  if (followup) {
    return { content: followup, hasInputContext: false, query: u.text }
  }

  const refinement = attachments.length ? undefined : followupQuery(u.text)
  const reference = refinement ? undefined : await resolveReferenceQuery(u.text, u.references ?? [], history, visibleForTurn, u.includeR18)
  if (reference?.reply && (!attachments.length || u.references?.length)) {
    return {
      content: {
        text: reference.reply,
        imageIds: [],
        how: null,
        readLibraryMetadata: true,
        focusReferences: reference.focusReferences
      },
      hasInputContext: false,
      query: u.text,
      reference
    }
  }

  const hasInputContext = attachments.length > 0 || !!reference?.modelNote
  const proposal = u.preparedProposalId
    ? await restorePreparedProposal(u.preparedProposalId)
    : hasInputContext
      ? null
      : await prepareCategoryRequest(u.text, scopeName ?? undefined, user.id).catch(directoryFeedback)
  if (proposal) {
    return {
      content: { ...proposal, how: null, imageIds: [] },
      hasInputContext,
      query: u.text,
      reference
    }
  }

  const image = attachments.find((a) => a.kind === 'image')
  const imageLookup = image && !u.text.trim() && attachments.length === 1 && !reference?.modelNote
  if (imageLookup && !(await hasSearchableImage(dirs, false))) {
    return {
      content: { text: '当前类目录范围内没有可按画面检索的普通图片。', how: null, imageIds: [] },
      hasInputContext,
      query: u.text,
      reference
    }
  }
  if (imageLookup) {
    let imageIds: number[]
    try {
      imageIds = await searchByImage(image, dirs)
    } catch (err) {
      throw classifyCloudError(err)
    }
    return {
      content: {
        text: localReply(imageIds.length),
        how: `按你传的图找了相似的${scopeConds.length ? `（${scopeConds.map(([k, v]) => `${k}「${v}」`).join('，')}）` : ''}，找到 ${imageIds.length} 张`,
        imageIds,
        evidence: { methods: Object.fromEntries(imageIds.map((id) => [id, 'vector' as const])) },
        incomplete: (await missingSearchVector(EMBEDDING_CONFIG.model, { dirs, tagGroups: [], keywordGroups: [] }))
          ? '部分图片尚无画面向量'
          : undefined
      },
      hasInputContext,
      query: u.text,
      reference
    }
  }

  const rawInput = refinement ?? u.text
  const query = requestedSearch(rawInput) ?? rawInput
  let recent: number[] | undefined
  if (refinement) {
    const refs = u.references?.length
      ? u.references
      : referencedHistory(history.filter((m) => m.createTime.getTime() > Date.now() - SEARCH_CACHE_TTL))
    if (refs.length) recent = await filterReferenceIds(refs, visibleForTurn)
  }
  const candidateIds = refinement === undefined ? undefined : recent ?? []
  if (candidateIds?.length === 0) {
    return {
      content: {
        text: recent ? '上轮结果中没有当前可继续筛选的图片。' : '最近一天没有可继续筛选的检索结果。',
        how: null,
        imageIds: []
      },
      hasInputContext,
      query,
      refinement,
      candidateIds,
      reference
    }
  }

  const explicit = hasInputContext ? null : routeTagRequest(rawInput, dict.tags, dict.dirs)
  const lastReply = history.findLast((row) => row.role === 'ASSISTANT')?.content as AssistantContent | undefined
  const implicitLookup = !lastReply || !!lastReply.how || !!refinement || requestedSearch(rawInput) !== null || !cloudReady
  const routed = hasInputContext ? null : explicit ?? (implicitLookup ? routeLocally(rawInput, dict.tags, dict.dirs) : null)

  // 空范围保护：用户在空目录里直接发找图请求或短特征词时，不浪费云端请求（对话指代语句除外）
  const likelyEmptyScopeLookup =
    !hasInputContext &&
    (routed !== null ||
      requestedSearch(rawInput) !== null ||
      (scopeName !== null &&
        Array.from(rawInput.trim()).length <= 8 &&
        !/[？?]|刚才|上次|这|那|什么|怎么|为什么|聊聊|讲讲/u.test(rawInput)))
  if (likelyEmptyScopeLookup && !(await hasSearchableImage(dirs, u.includeR18))) {
    return {
      content: { text: await emptyScopeText(dirs, u.includeR18), how: null, imageIds: [] },
      hasInputContext,
      query,
      refinement,
      candidateIds,
      reference
    }
  }

  if (routed) {
    const spec = explicit ? explicit.spec : descriptiveSpec(routed, dict.tags)
    const routeDirs =
      dirs ??
      (routed.dirs.length
        ? routed.dirs.map((d) => ({
            rootId: d.rootId,
            prefix: d.kind === 'SOURCE' ? '' : d.name
          }))
        : undefined)
    const supplement = spec.keywordGroups.length ? await localVisualSupplement(query, callModel, SEARCH_IMAGES_TOOL) : undefined
    if (supplement?.visualInclude?.length) {
      spec.visualInclude = supplement.visualInclude
      if (spec.keywordGroups.length === 1 && supplement.text && !spec.keywordGroups[0].includes(supplement.text.toLowerCase())) {
        spec.keywordGroups[0] = [...spec.keywordGroups[0], supplement.text.toLowerCase()]
      }
    }
    if (supplement?.visualExclude?.length) spec.visualExclude = supplement.visualExclude
    const { imageIds, evidence, incomplete } = await runSearch(
      spec,
      routeDirs,
      u.includeR18,
      dict.tags,
      supplement?.vector,
      candidateIds
    )
    const conds = [...scopeConds, ...routed.conds.filter((c) => !(dirs && c[0] === '范围'))]
    if (supplement) conds.push(['画面', supplement.text])
    return {
      content: {
        text: localReply(imageIds.length),
        how: howText(conds, imageIds.length),
        imageIds,
        evidence,
        incomplete:
          incomplete ??
          (spec.keywordGroups.length && !supplement && (await hasSearchableImage(routeDirs, false))
            ? '画面相似度检索暂不可用'
            : undefined)
      },
      hasInputContext,
      query,
      refinement,
      candidateIds,
      reference
    }
  }

  return { hasInputContext, query, refinement, candidateIds, reference }
}
