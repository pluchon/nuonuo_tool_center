import {
  AI_TEXT_MAX,
  AI_TITLE_MAX,
  type AiAskDTO,
  type AiAskResultVO,
  type AiAttachment,
  type AiCompactResult,
  type AiConversationVO,
  type AiMessageVO,
  type AiRecalledDraft,
  type AiReplyCacheUsage,
  type AiStatusVO,
  type AiStreamEvent,
  type DirKeyDTO,
  type GalleryItemVO
} from '@shared/api'
import { BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'
import { BizError } from '../../common/bizError'
import {
  findCompactionsByConversation,
  findConversation,
  findConversations,
  findMessages,
  findRecalledMessage,
  insertConversation,
  insertMessage,
  reviseLastUserMessage,
  updateConversation,
  updateVote,
  type AiConversationEntity,
  type AiMessageEntity
} from '../../repositories/aiConversationRepository'
import { cachedSearchValue, searchCacheKey } from '../../repositories/aiSearchCacheRepository'
import { hasSearchableImage, visibleResultIds } from '../../repositories/aiSearchRepository'
import { itemsOfImages } from '../galleryService'
import { checkAttachments, type StoredAttachment } from './assistantAttachment'
import { cardCaption } from './assistantPrompt'
import {
  checkReferences,
  conversationFocus,
  ordinaryReferenceDetails,
  referencedHistory,
  scopeDirs,
  visibleReferenceResults
} from './assistantReferences'
import { chatCall } from './bailianClient'
import { classifyCloudError } from './cloudErrors'
import { workingHistory, type CompactionProgress } from './conversationCompaction'
import { recordEvent } from './eventService'
import { estimateCompactedUsage, historyTurns } from './harness/context'
import { requestedSearch, tryFastPath } from './harness/fastPath'
import { isCloudReady, runAgentLoop, runVisionTurn } from './harness/harness'
import { dispatchTool } from './harness/toolRegistry'
import { ASSISTANT_TOOL_MAP } from './harness/tools'
import {
  attachmentsOf,
  createInitialHarnessState,
  localReplyText,
  reduceToolOutcome,
  replyText,
  type AssistantContent,
  type CurrentConversation,
  type ToolEnv,
  type UserContent
} from './harness/types'
import type { DictTag } from './localRouter'
import { relevantMemories } from './memoryRetrieval'
import { ensureProfile } from './profileService'
import { emptyScopeText, howText, loadDictionary, runSearch } from './search/hybridSearch'

// 给模型看的结果最多几张
const BRIEF_MAX = 8

// 正在回答的对话（同一段对话不并发回答）
const answering = new Set<number>()

export function getAiStatus(): AiStatusVO {
  return { ready: !!readCloudCredentials().dashscopeApiKey }
}

function toConversationVO(c: AiConversationEntity & { lastAt: Date }): AiConversationVO {
  return { id: c.id, title: c.title, pinned: c.pinned, updatedAt: c.lastAt.toISOString() }
}

export async function listConversations(): Promise<AiConversationVO[]> {
  return (await findConversations()).map(toConversationVO)
}

function toMessageVO(m: AiMessageEntity, images: GalleryItemVO[] = []): AiMessageVO {
  const base = { id: m.id, vote: m.vote ?? null, createdAt: m.createTime.toISOString() }
  if (m.role === 'USER') {
    const c = m.content as UserContent
    const attachments = attachmentsOf(c).map((file): AiAttachment =>
      file.kind === 'image' ? { kind: file.kind, name: file.name, mimeType: file.mimeType, dataUrl: file.dataUrl } : file
    )
    return {
      ...base,
      role: 'user',
      text: c.text,
      scope: c.scope,
      includeR18: c.includeR18,
      how: null,
      images: [],
      attachments,
      ...(c.references?.length ? { references: c.references } : {}),
      image: attachments.find((a) => a.kind === 'image')?.dataUrl ?? null,
      attachment: attachments[0] ?? null
    }
  }
  const c = m.content as AssistantContent
  const hasStoredResults = Boolean(c.imageIds?.length)
  const allHidden = hasStoredResults && !images.length
  return {
    ...base,
    role: 'assistant',
    hasStoredResults,
    images,
    image: null,
    ...(c.categoryProposalId ? { categoryProposalId: c.categoryProposalId, proposalNote: c.proposalNote } : {}),
    ...(c.contextUsage ? { contextUsage: c.contextUsage } : {}),
    ...(c.nextPrediction ? { canPredict: true } : {}),
    ...(c.cacheUsage ? { cacheUsage: c.cacheUsage } : {}),
    text: allHidden ? '这些图片目前不在检索范围内。' : replyText(c),
    how: allHidden
      ? null
      : c.incomplete && c.how
        ? c.how.replace(/，找到 \d+ 张$/u, '') + `。目前显示 ${images.length} 张，${c.incomplete}。`
        : c.how?.replace(/(?:至少)?找到 \d+ 张$/u, `找到 ${images.length} 张`) ?? null
  }
}

export async function listMessages(conversationId: number): Promise<AiMessageVO[]> {
  checkId(conversationId)
  const conversation = await findConversation(conversationId)
  if (!conversation) throw new BizError('NOT_FOUND', '这段对话已经不在了')
  const rows = (await findMessages(conversationId)).filter((m) => m.role !== 'TOOL')
  // 同一目录的历史消息共用一次查询，每轮仍按当时的目录和 R-18 开关恢复卡片。
  const batches = new Map<string, { scope: DirKeyDTO | null; ids: Set<number>; includeR18: boolean; items: Map<number, GalleryItemVO> }>()
  let scope: DirKeyDTO | null = null
  let includeR18 = false
  const messages = rows.map((row) => {
    if (row.role === 'USER') {
      const user = row.content as UserContent
      scope = user.scope ?? null
      includeR18 = user.includeR18 === true
      return { row, includeR18 }
    }
    const ids = (row.content as AssistantContent).imageIds ?? []
    const key = JSON.stringify(scope)
    const batch = batches.get(key) ?? { scope, ids: new Set<number>(), includeR18: false, items: new Map<number, GalleryItemVO>() }
    for (const id of ids) batch.ids.add(id)
    batch.includeR18 ||= includeR18
    batches.set(key, batch)
    return { row, ids, batch, includeR18 }
  })
  for (const batch of batches.values()) {
    if (!batch.ids.size || batch.scope?.kind === 'source') continue
    const items = await itemsOfImages([...batch.ids], batch.includeR18, await scopeDirs(batch.scope))
    for (const item of items) batch.items.set(item.imageId, item)
  }
  const result = messages.map(({ row, ids, batch, includeR18: rowIncludeR18 }) => {
    const images: GalleryItemVO[] = []
    for (const id of ids ?? []) {
      const item = batch?.items.get(id)
      if (item && (rowIncludeR18 || !item.isR18)) images.push(item)
    }
    return toMessageVO(row, images)
  })
  const compactions = new Map((await findCompactionsByConversation(conversationId)).map((c) => [c.upToMessageId, c.summary]))
  const latest = rows.findLastIndex(
    (row) => row.role === 'ASSISTANT' && Boolean(compactions.get(row.id) || (row.content as AssistantContent).compactSummary || (row.content as AssistantContent).contextUsage)
  )
  const summary = latest >= 0 ? compactions.get(rows[latest].id) ?? (rows[latest].content as AssistantContent).compactSummary : undefined
  if (summary) {
    const { turns: tail } = await historyTurns(rows.slice(latest + 1))
    const lastReply = result.findLast((m) => m.role === 'assistant')!
    lastReply.contextUsage = await estimateCompactedUsage(conversation, [
      ...[{ role: 'user' as const, content: '[软件记录] 以下是前文摘要，供继续对话时参考。' }, { role: 'assistant' as const, content: summary }],
      ...tail.flatMap((t) => t.messages)
    ])
  }
  return result
}

function checkId(id: unknown): asserts id is number {
  if (!Number.isInteger(id) || (id as number) <= 0) {
    throw new BizError('BAD_REQUEST', 'id 不对')
  }
}

function checkScope(scope: unknown): DirKeyDTO | null {
  if (scope === null || scope === undefined) return null
  const s = scope as DirKeyDTO
  if (s.kind === 'source') throw new BizError('BAD_REQUEST', '诺诺助手只能检索类目录')
  if (s.kind === 'category' && typeof s.name === 'string') {
    const normalized = s.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const parts = normalized.split('/').filter(Boolean)
    if (
      normalized &&
      parts.length > 0 &&
      parts.every((p) => p !== '.' && p !== '..' && !/[:*?"<>|\u0000-\u001f]/.test(p))
    ) {
      return { kind: 'category', name: parts.join('/') }
    }
  }
  throw new BizError('BAD_REQUEST', '范围不对')
}

async function changeConversation<T>(id: number, change: (conversation: CurrentConversation) => Promise<T>): Promise<T> {
  checkId(id)
  if (answering.has(id)) throw new BizError('CONFLICT', '诺诺正在处理这段对话')
  answering.add(id)
  try {
    const conversation = await findConversation(id)
    if (!conversation) throw new BizError('NOT_FOUND', '这段对话已经不在了')
    return await change(conversation)
  } finally {
    answering.delete(id)
  }
}

function recalledDraft(row: AiMessageEntity): AiRecalledDraft {
  const content = row.content as UserContent
  return {
    messageId: row.id,
    text: content.text,
    attachments: toMessageVO(row).attachments ?? [],
    references: content.references ?? [],
    scope: content.scope?.kind === 'category' ? content.scope : null,
    includeR18: content.includeR18 === true
  }
}

export async function getRecalledDraft(conversationId: number): Promise<AiRecalledDraft | null> {
  checkId(conversationId)
  if (!(await findConversation(conversationId))) throw new BizError('NOT_FOUND', '这段对话已经不在了')
  const row = await findRecalledMessage(conversationId)
  return row ? recalledDraft(row) : null
}

export async function recallMessage(conversationId: number, messageId: number): Promise<AiRecalledDraft> {
  checkId(messageId)
  return changeConversation(conversationId, async () => recalledDraft(await reviseLastUserMessage(conversationId, messageId)))
}

export async function editMessage(conversationId: number, messageId: number, text: string): Promise<AiMessageVO> {
  checkId(messageId)
  if (typeof text !== 'string' || Array.from(text.trim()).length > AI_TEXT_MAX) throw new BizError('BAD_REQUEST', `一次最多 ${AI_TEXT_MAX} 个字`)
  return changeConversation(conversationId, async () =>
    toMessageVO(
      await reviseLastUserMessage(conversationId, messageId, (row) => {
        const content = row.content as UserContent
        if (!text.trim() && !attachmentsOf(content).length && !content.references?.length) throw new BizError('BAD_REQUEST', '说点什么吧')
        return { ...content, preparedProposalId: undefined, text: text.trim() }
      })
    )
  )
}

export async function ask(dto: AiAskDTO): Promise<AiAskResultVO> {
  if (dto?.conversationId == null) return saveQuestion(dto)
  return changeConversation(dto.conversationId, (conversation) => saveQuestion(dto, conversation))
}

async function saveQuestion(dto: AiAskDTO, current?: CurrentConversation): Promise<AiAskResultVO> {
  const text = typeof dto?.text === 'string' ? dto.text.trim() : ''
  if (Array.from(text).length > AI_TEXT_MAX) {
    throw new BizError('BAD_REQUEST', `一次最多 ${AI_TEXT_MAX} 个字`)
  }
  let recalled: StoredAttachment[] = []
  if (dto?.recalledMessageId !== undefined) {
    checkId(dto.recalledMessageId)
    checkId(dto.conversationId)
    const row = await findRecalledMessage(dto.conversationId)
    if (row?.id !== dto.recalledMessageId) throw new BizError('CONFLICT', '这条草稿已经变更，请重新打开对话')
    recalled = attachmentsOf(row.content as UserContent)
  }
  const { attachments, original } = await checkAttachments(dto?.attachments, dto?.attachment, dto?.image, recalled)
  const references = await checkReferences(dto?.references, dto?.conversationId, (ids, origin) => visibleReferenceResults(ids, origin, dto))
  if (!text && !attachments.length && !references.length) throw new BizError('BAD_REQUEST', '说点什么吧')
  const content: UserContent = {
    text,
    scope: checkScope(dto.scope),
    includeR18: dto.includeR18 === true,
    ...(attachments.length ? { attachments } : {}),
    ...(references.length ? { references } : {})
  }
  let conversation = current
  if (!conversation) {
    // 新对话锁定当前的核心档案版本，这段对话里前缀不变
    const profile = await ensureProfile()
    const referenceTitle = references.length === 1 ? references[0].name : references.length ? references.length + ' 张图库图片' : ''
    const title = text
      ? Array.from(text).slice(0, 14).join('')
      : attachments.find((a) => a.kind === 'markdown')?.name || attachments[0]?.name || referenceTitle || '按图找相似'
    const chars = Array.from(title)
    const created = await insertConversation(chars.length <= AI_TITLE_MAX ? title : chars.slice(0, AI_TITLE_MAX - 1).join('') + '…', profile.version)
    conversation = { ...created, lastAt: created.createTime }
  }
  const message = await insertMessage(conversation.id, 'USER', content, original)
  return { conversation: { ...toConversationVO(conversation), updatedAt: message.createTime.toISOString() }, message: toMessageVO(message) }
}

// 只有脱离历史也有明确含义的找图请求可以复用计划；记忆、词表、模型或范围变化时重新规划。
async function standalonePlanKey(
  query: string,
  u: UserContent,
  history: AiMessageEntity[],
  tags: Array<DictTag & { general: boolean }>,
  version: number | null
) {
  const hasShownInHistory = history.some(
    (m) => m.role === 'ASSISTANT' && ((m.content as AssistantContent).imageIds?.length ?? 0) > 0
  )
  const followUpOrConversational =
    /[这那它她他]|上次|刚才|前面|继续|再来|其中|剩下|其他|另外|一样|相似|要求|记住|偏好|喜欢|推荐|解释|比较|第.{0,4}张|按.*(?:筛选|描述)|还有|换|别|看过|爱了|好看|可爱|漂亮|不错|萌|绝了|太棒|诺诺/u
  if (
    attachmentsOf(u).length ||
    query.length > 120 ||
    followUpOrConversational.test(query) ||
    followUpOrConversational.test(u.text) ||
    (hasShownInHistory && /(?:还有|换|别|再|更多|没看够|类似|差不多的|[？?吗呢]$)/u.test(u.text.trim()))
  ) {
    return
  }
  const context: string[] = []
  for (const message of history) {
    if (message.role === 'USER') {
      const previous = message.content as UserContent
      if (attachmentsOf(previous).length) return
      if (previous.text !== u.text) context.push(previous.text)
    } else {
      const reply = message.content as AssistantContent
      if (!reply.how || (!reply.cardCaption && reply.text && reply.text !== localReplyText(0))) return
    }
  }
  const memories = await relevantMemories(u.text)
  return searchCacheKey('search-plan-v2', [
    BAILIAN_CONFIG.chatModel,
    u.text.trim(),
    context,
    u.scope,
    u.includeR18,
    version,
    tags.map((t) => [t.name, t.aliases, t.category, t.general]),
    memories.map((m) => [m.id, m.content])
  ])
}

export async function compactConversation(id: number): Promise<AiCompactResult> {
  return changeConversation(id, async (conversation) => {
    const { turns } = await historyTurns(await findMessages(id))
    const { changed, messages } = await workingHistory(turns, 0, true)
    const last = turns.at(-1)
    const checkpoint = last?.summary ? { messageId: last.id, usage: await estimateCompactedUsage(conversation, messages) } : null
    return { changed, checkpoint }
  })
}

// 回答这段对话里最后一句还没回复的话：确定性快路径直出，其余进入 Harness 单主循环
export async function answer(
  conversationId: number,
  compactionProgress?: CompactionProgress,
  onStream?: (ev: Omit<AiStreamEvent, 'conversationId'>) => void
): Promise<AiMessageVO> {
  checkId(conversationId)
  if (answering.has(conversationId)) {
    throw new BizError('CONFLICT', '诺诺还在回上一句')
  }
  answering.add(conversationId)
  try {
    const conversation = await findConversation(conversationId)
    if (!conversation) {
      throw new BizError('NOT_FOUND', '这段对话已经不在了')
    }
    const rows = (await findMessages(conversationId)).filter((m) => m.role !== 'TOOL')
    const user = rows[rows.length - 1]
    if (!user || user.role !== 'USER') {
      throw new BizError('CONFLICT', '没有要回复的话')
    }
    const u = user.content as UserContent
    const attachments = attachmentsOf(u)
    const history = rows.slice(0, -1)
    const dirs = await scopeDirs(u.scope)
    const scopeName = u.scope?.kind === 'category' ? u.scope.name : null
    const scopeConds: Array<[string, string]> = scopeName ? [['范围', scopeName]] : []

    const visibleForTurn = async (ids: number[], source?: number) => {
      if (source === undefined) return visibleResultIds(ids, u.includeR18, await scopeDirs(u.scope))
      const origin = rows.findLast((r) => r.id < source && r.role === 'USER')?.content as UserContent | undefined
      return visibleReferenceResults(ids, origin ?? {}, u)
    }

    const modelUsage: Array<AiReplyCacheUsage | undefined> = []
    const callModel: typeof chatCall = async (request) => {
      const result = await chatCall(request)
      modelUsage.push(result.cacheUsage)
      return result
    }

    const dict = await loadDictionary()
    const fast = await tryFastPath({
      user,
      history,
      attachments,
      dirs,
      scopeName,
      scopeConds,
      dict,
      cloudReady: isCloudReady(),
      callModel,
      visibleForTurn
    })

    let content: AssistantContent
    let allAlreadyShown = false
    if (fast.content) {
      content = fast.content
    } else {
      const image = attachments.find((a) => a.kind === 'image')
      const { turns, previousResults } = await historyTurns(history)
      const focus = !fast.hasInputContext && !fast.refinement ? conversationFocus(history.slice(-8)) : []
      const ordinaryFocus = await ordinaryReferenceDetails(focus.slice(0, BRIEF_MAX), visibleForTurn, !!u.scope, u.includeR18)
      const focusSignature = ordinaryFocus.length ? searchCacheKey('focus', ordinaryFocus) : undefined
      const recentRemarks = focusSignature
        ? history
            .slice(-6)
            .filter((m) => m.role === 'ASSISTANT' && (m.content as AssistantContent).focusSignature === focusSignature)
            .map((m) => replyText(m.content as AssistantContent).slice(0, 400))
        : []
      const focusNote = focusSignature
        ? '前文讨论的图库图片（当前元数据，仅在用户承接话题时参考）：' + JSON.stringify({ 图片: ordinaryFocus, 近期回应: recentRemarks })
        : undefined
      const latestPlan = history.findLast((m) => m.role === 'ASSISTANT' && (m.content as AssistantContent).categoryProposalId)
      const shownIdOrder: number[] = []
      const seenShownIds = new Set<number>()
      for (let i = history.length - 1; i >= 0 && shownIdOrder.length < 40; i--) {
        const row = history[i]
        if (row.role !== 'ASSISTANT') continue
        const ids = (row.content as AssistantContent).imageIds
        if (!Array.isArray(ids)) continue
        for (const id of ids) {
          if (Number.isInteger(id) && id > 0 && !seenShownIds.has(id)) {
            seenShownIds.add(id)
            shownIdOrder.push(id)
            if (shownIdOrder.length >= 40) break
          }
        }
      }
      let shownImages: Array<{ id: number; name: string | null }> | undefined
      if (shownIdOrder.length > 0) {
        const visibleIds = await visibleForTurn(shownIdOrder)
        const visibleOrdered = shownIdOrder.filter((id) => visibleIds.has(id))
        if (visibleOrdered.length > 0) {
          const ordinaryItems = await itemsOfImages(visibleOrdered, false, dirs)
          const nameById = new Map(ordinaryItems.map((item) => [item.imageId, item.name]))
          shownImages = visibleOrdered.map((id) => ({ id, name: nameById.get(id) ?? null }))
        }
      }
      const env: ToolEnv = {
        userText: u.text,
        query: fast.query,
        hasInputContext: fast.hasInputContext,
        compactionProgress,
        tags: dict.tags,
        dirs,
        selectedCategory: scopeName ?? undefined,
        includeR18: u.includeR18,
        userMessageId: user.id,
        candidateIds: fast.candidateIds,
        previousResults,
        shownImages,
        previousProposal: latestPlan
          ? { id: (latestPlan.content as AssistantContent).categoryProposalId!, messageId: latestPlan.id }
          : undefined,
        readReferences: async () => {
          if (attachments.length && !u.references?.length) return []
          const refs = u.references?.length ? u.references : conversationFocus(history)
          const chosen = refs.length ? refs : referencedHistory(history)
          return ordinaryReferenceDetails(chosen, visibleForTurn, !u.references?.length && !!u.scope, u.includeR18)
        },
        referenceNotes: fast.reference?.modelNote ?? focusNote,
        modelReferences: fast.reference?.modelReferences
      }

      const stateRef = { current: createInitialHarnessState(fast.hasInputContext, !!fast.reference?.modelNote) }
      let text = ''
      let answered = false
      const key = !fast.refinement && !fast.hasInputContext && (await standalonePlanKey(fast.query, u, history, dict.tags, conversation.profileVersion))

      const generate = async () => {
        if (image) {
          // 上传图像在本地完成分级闸门校验后再检查云端密钥，避免受限图片在离线时被误放行。
          const vision = await runVisionTurn(turns, user, env, stateRef, async (req) => {
            if (!isCloudReady()) throw new BizError('DEPENDENCY_FAILED', '诺诺还没连上云端')
            return callModel(req)
          }, image, onStream)
          text = vision.text
          answered = true
          return undefined
        }
        if (!isCloudReady()) {
          if (!fast.hasInputContext && (fast.refinement || requestedSearch(u.text))) {
            const outcome = await runSearch(
              { tagGroups: [], keywordGroups: [[fast.query.toLowerCase()]] },
              dirs,
              u.includeR18,
              dict.tags,
              undefined,
              fast.candidateIds
            )
            outcome.incomplete = '目前仅完成本地文字检索'
            stateRef.current = {
              ...stateRef.current,
              lastSearch: { outcome, conds: [['关键词', fast.query]] }
            }
            answered = true
            return undefined
          }
          throw new BizError('DEPENDENCY_FAILED', '诺诺还没连上云端')
        }
        const loop = await runAgentLoop(conversation, turns, history, user, env, stateRef, scopeName, callModel, onStream)
        text = loop.text
        answered = true
        return !stateRef.current.needsDetails && !stateRef.current.otherToolUsed ? stateRef.current.cacheablePlan : undefined
      }

      try {
        const cached = key
          ? await cachedSearchValue(
              key,
              (value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value),
              generate
            )
          : undefined
        if (cached && !answered) {
          const replayed = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', JSON.stringify(cached), env, stateRef.current)
          stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', replayed.outcome)
        }
        if (!answered && !stateRef.current.lastSearch) await generate()
      } catch (err) {
        if (!stateRef.current.lastSearch && stateRef.current.awaitingContrast) {
          const fallback = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', '{}', env, stateRef.current)
          stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', fallback.outcome)
        }
        if (!stateRef.current.lastSearch) throw classifyCloudError(err)
        stateRef.current.lastSearch.outcome.incomplete ??= '后续的云端核对暂未完成'
      }

      const state = stateRef.current

      if (state.exclusionReply) {
        content = {
          text: state.exclusionReply.text,
          how: state.exclusionReply.how,
          imageIds: state.exclusionReply.imageIds,
          evidence: state.exclusionReply.evidence,
          incomplete: state.exclusionReply.incomplete,
          readLibraryMetadata: true,
          ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
          memoryIds: state.memoryIds ?? []
        }
      } else {
        const outcome = state.lastSearch?.outcome
        const imageIds = outcome?.imageIds ?? []
        const found = imageIds.length
        allAlreadyShown = Boolean(outcome?.allAlreadyShown)
        content = {
          text:
            state.directoryProposal?.text ??
            (outcome && !state.needsDetails
              ? state.lastSearch?.caption ?? (text || localReplyText(found))
              : text || '诺诺没想好怎么回答，换个说法再问一次吧。'),
          ...(state.lastSearch?.caption && !state.needsDetails ? { cardCaption: true } : {}),
          ...(state.directoryProposal?.categoryProposalId
            ? { categoryProposalId: state.directoryProposal.categoryProposalId, proposalNote: state.directoryProposal.proposalNote }
            : {}),
          how: state.lastSearch ? howText([...scopeConds, ...state.lastSearch.conds], found) : null,
          imageIds,
          evidence: outcome?.evidence,
          incomplete: outcome?.incomplete,
          ...(fast.reference?.focusReferences?.length ? { focusReferences: fast.reference.focusReferences } : {}),
          ...(state.readLibraryMetadata || focusSignature ? { readLibraryMetadata: true } : {}),
          ...(focusSignature && !state.readLibraryMetadata && !outcome && !state.directoryProposal ? { focusSignature } : {}),
          ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
          ...(state.discussionReply?.suggestion && !state.readLibraryMetadata && !focusSignature && !fast.hasInputContext
            ? { nextPrediction: state.discussionReply.suggestion }
            : {}),
          memoryIds: state.memoryIds ?? []
        }
        if (outcome && !found && !allAlreadyShown && !(await hasSearchableImage(dirs, u.includeR18))) {
          content.text = await emptyScopeText(dirs, u.includeR18)
          content.how = null
          content.incomplete = undefined
        }
      }
    }

    // 各请求按输入量加权。纯本地回复或任何一次缺少统计时，都没有完整的模型命中率。
    if (modelUsage.length && modelUsage.every((item) => item !== undefined)) {
      content.cacheUsage = modelUsage.reduce((a, b) => ({
        inputTokens: a.inputTokens + b.inputTokens,
        cachedTokens: a.cachedTokens + b.cachedTokens
      }))
    }
    if (content.incomplete && !content.imageIds.length && !allAlreadyShown) content.text = '目前只完成了部分检索。'
    if (content.imageIds.length && !content.text) {
      const previous = history.findLast((row) => row.role === 'ASSISTANT')?.content as AssistantContent | undefined
      content.text = cardCaption(
        content.imageIds.length,
        previous?.text,
        attachments.some((a) => a.kind === 'image') ? 'similar' : fast.refinement ? 'refine' : 'search'
      )
      content.cardCaption = true
    }
    const saved = await insertMessage(conversationId, 'ASSISTANT', content)
    return toMessageVO(saved, await itemsOfImages(content.imageIds, u.includeR18, dirs))
  } finally {
    answering.delete(conversationId)
  }
}

export async function renameConversation(id: number, title: string): Promise<AiConversationVO> {
  checkId(id)
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) throw new BizError('BAD_REQUEST', '名字不能是空的')
  if (Array.from(name).length > AI_TITLE_MAX) throw new BizError('BAD_REQUEST', `名字最多 ${AI_TITLE_MAX} 个字`)
  if ((await updateConversation(id, { title: name })) === 0) throw new BizError('NOT_FOUND', '这段对话已经不在了')
  return toConversationVO((await findConversation(id))!)
}

export async function pinConversation(id: number, pinned: boolean): Promise<void> {
  checkId(id)
  if ((await updateConversation(id, { pinned: pinned === true })) === 0) throw new BizError('NOT_FOUND', '这段对话已经不在了')
}

export async function deleteConversation(id: number): Promise<void> {
  checkId(id)
  if (!(await findConversation(id))) throw new BizError('NOT_FOUND', '这段对话已经不在了')
  await updateConversation(id, { deleteState: 1 })
}

export async function undoDeleteConversation(id: number): Promise<void> {
  checkId(id)
  if (!(await findConversation(id, true))) throw new BizError('NOT_FOUND', '这段对话已经不在了')
  await updateConversation(id, { deleteState: 0 })
}

export async function voteMessage(messageId: number, vote: 'UP' | 'DOWN' | null): Promise<void> {
  checkId(messageId)
  if (vote !== 'UP' && vote !== 'DOWN' && vote !== null) throw new BizError('BAD_REQUEST', '反馈不对')
  const updated = await updateVote(messageId, vote)
  if (!updated) throw new BizError('NOT_FOUND', '这条回复已经不在了')
  // 赞和踩只当弱参考：记进事件流，做梦时调整这次用到的记忆的可信度
  if (vote) {
    await recordEvent('reply.vote', null, { vote, memoryIds: (updated.content as AssistantContent).memoryIds ?? [] })
  }
}

export function isAnswering(): boolean {
  return answering.size > 0
}

export async function suggestIdeas(random: () => number = Math.random): Promise<string[]> {
  const dict = await loadDictionary()
  const pool = (category: string): string[] => dict.tags.filter((t) => t.category === category && t.general).map((t) => t.name)
  const character = pool('角色')
  const work = pool('作品')
  const theme = pool('主题')
  const place = pool('地点')
  const dirNames = dict.dirs.map((d) => d.name)
  const any = (a: string[]): string => a[Math.floor(random() * a.length)]
  const templates: Array<[string[][], () => string]> = [
    [[character], () => `找${any(character)}的图`],
    [[work, theme], () => `${any(work)}里的${any(theme)}`],
    [[place], () => `${any(place)}拍的${any(['风景', '夜景', '照片'])}`],
    [[dirNames, theme], () => `${any(dirNames)}里的${any(theme)}`],
    [[theme], () => `最近导入的${any(theme)}`],
    [[theme], () => `${any(theme)}的图，要竖的`],
    [[character, theme], () => `${any(character)}的${any(theme)}`],
    [[work], () => `${any(work)}的图`]
  ]
  const usable = templates.filter(([need]) => need.every((p) => p.length > 0))
  for (let k = usable.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1))
    ;[usable[k], usable[j]] = [usable[j], usable[k]]
  }
  const ideas: string[] = ['陪我聊聊今天的事', '一起想个故事开头']
  for (const [, make] of usable) {
    const t = make()
    if (ideas.length < 4 && !ideas.includes(t)) {
      ideas.push(t)
    }
  }
  return ideas
}
