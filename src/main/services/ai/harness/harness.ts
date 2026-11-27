import type { AiStreamEvent, AiTimelineBlock } from '@shared/api'
import { BAILIAN_CONFIG, EMBEDDING_CONFIG, readCloudCredentials } from '../../../config/cloudConfig'
import { getLibraryVersion } from '../../../common/readCache'
import { missingSearchVector } from '../../../repositories/aiSearchRepository'
import type { AiConversationEntity, AiMessageEntity } from '../../../repositories/aiConversationRepository'
import type { StoredAttachment } from '../assistantAttachment'
import { ASSISTANT_RULES, PERSONA_FEW_SHOT_MESSAGES } from '../assistantPrompt'
import type { chatCall } from '../bailianClient'
import { contextUsage, fitContext } from '../contextWindow'
import { workingHistory, type HistoryTurn } from '../conversationCompaction'
import { prepareRatedUpload } from '../embeddingService'
import { relevantMemories } from '../memoryRetrieval'
import { profileSnapshotForConversation } from '../profileService'
import { buildMessages, markStepCache, stableStringify, type PromptMessage } from '../promptPrefix'
import type { MatchEvidence } from '../searchFeedback'
import { loadDictionary, localReply, searchByImage } from '../search/hybridSearch'
import { buildTurnTail, microcompactTail, tailBytes } from './context'
import { dispatchTool, isToolError, parseToolJson, type RegisteredTool, type ToolExecutionResult } from './toolRegistry'
import { ASSISTANT_TOOL_MAP, ASSISTANT_TOOLS } from './tools'
import { previousReceipt } from './tools/categoryTools'
import { reduceToolOutcome, replyText, userText, type AssistantContent, type HarnessState, type ToolEnv, type UserContent } from './types'

// 一次回答最多调几次模型（含工具往返）
const MAX_STEPS = 7

export type StreamCallback = (ev: Omit<AiStreamEvent, 'conversationId'>) => void

export function isCloudReady(): boolean {
  return !!readCloudCredentials().dashscopeApiKey
}

export function isConversationalSearch(text: string): boolean {
  return /喜欢|爱了|好看|可爱|漂亮|不错|萌|绝了|太棒|还有|换|别的|其他|看过|诺诺/u.test(text)
}

function normalizeToolCallKey(name: string, rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs || '{}') as unknown
    return `${name}:${stableStringify(parsed)}`
  } catch {
    return `${name}:${rawArgs.trim()}`
  }
}

function parseArgsObject(rawArgs: string): Record<string, unknown> {
  const parsed = parseToolJson(rawArgs)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isPrematureSearchClaim(text: string): boolean {
  return /(?:找到啦|找到了|给你看看|这几张|都在这里|端上来)/u.test(text)
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/giu, '').replace(/<\/?think>/giu, '')
}

const LEAKED_THINKING_STARTERS = [
  '<think>',
  '用户说', '用户问', '用户想要', '用户希望', '用户要求', '用户刚才', '用户在', '用户让我', '用户想看', '用户提到', '用户发', '用户给',
  '让我分析', '让我先分析', '让我看看用户', '让我先看看用户', '让我检查', '让我先检查',
  '先分析', '思考：', '思考:', '内心', '【思考', '[思考',
  '好的，用户', '嗯，用户', '好，用户',
  '根据用户', '根据上轮', '根据上一轮', '根据前文', '根据会话状态',
  '承接上一轮', '本轮需要', '这里需要',
  '需要检索', '需要调用', '需要搜索', '需要先检索', '需要先调用', '需要先搜索',
  'let me', 'the user', 'thinking'
] as const

function couldBeLeakedThinkingPrefix(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed) return true
  const lower = trimmed.toLowerCase()
  return LEAKED_THINKING_STARTERS.some((starter) => starter.startsWith(lower))
}

function isLeakedThinkingPrefix(text: string): boolean {
  return /^\s*(?:<think>|用户(?:说|问|想要|希望|要求|刚才|在|让我|想看|提到|发|给)|让我(?:先)?(?:分析|看看用户|检查)|先分析|思考[:：]|内心|【思考|\[思考|(?:好的|嗯|好)[，,]用户|根据(?:用户|上轮|上一轮|前文|会话状态)|承接上一轮|本轮需要|这里需要|需要(?:先)?(?:检索|调用|搜索)|let\s+me\b|the\s+user\b|thinking[:：\s])/iu.test(
    text
  )
}

function isLeakedThinking(text: string): boolean {
  if (isLeakedThinkingPrefix(text)) return true
  return /(?:需要(?:先)?(?:检索|调用|搜索|排除|查看|核对|查询)|(?:调用|使用)\s*(?:search_images|web_search|get_image|list_tags|remember|recall_memories|propose_category_change|read_referenced_images|explain_match|exclude_image)|并排除已展示过的|排除已展示过|excludeShown|keywordGroups|visualInclude|contrast\s*[:：])/u.test(
    text
  )
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

function trailingTagCarryLength(text: string, target: string): number {
  const lower = text.toLowerCase()
  const maxLen = Math.min(lower.length, target.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (lower.endsWith(target.slice(0, len))) return len
  }
  return 0
}

function createThinkingStreamFilter(onStream?: StreamCallback) {
  let rawAll = ''
  let cleanAll = ''
  let inThink = false
  let tagCarry = ''
  let stepBuf = ''
  let streamFlushed = false
  let suppressed = false

  const pushVisible = (visible: string): void => {
    if (!visible || suppressed) return
    cleanAll += visible
    if (!streamFlushed) {
      stepBuf += visible
      if (isLeakedThinkingPrefix(stepBuf) || isLeakedThinking(stepBuf)) {
        suppressed = true
        stepBuf = ''
        return
      }
      if (!couldBeLeakedThinkingPrefix(stepBuf)) {
        streamFlushed = true
        const ready = stepBuf
        stepBuf = ''
        onStream?.({ kind: 'delta', text: ready })
      }
      return
    }
    if (isLeakedThinking(cleanAll)) {
      suppressed = true
      onStream?.({ kind: 'clear_stream' })
      return
    }
    onStream?.({ kind: 'delta', text: visible })
  }

  return {
    onDelta(chunk: string): void {
      rawAll += chunk
      if (suppressed) return
      let work = tagCarry + chunk
      tagCarry = ''
      let visible = ''
      while (work.length > 0) {
        if (inThink) {
          const closeIdx = work.toLowerCase().indexOf(THINK_CLOSE)
          if (closeIdx >= 0) {
            inThink = false
            work = work.slice(closeIdx + THINK_CLOSE.length)
            continue
          }
          const keep = trailingTagCarryLength(work, THINK_CLOSE)
          if (keep > 0) tagCarry = work.slice(-keep)
          work = ''
          break
        }
        const openIdx = work.toLowerCase().indexOf(THINK_OPEN)
        if (openIdx >= 0) {
          visible += work.slice(0, openIdx)
          inThink = true
          work = work.slice(openIdx + THINK_OPEN.length)
          continue
        }
        const keep = trailingTagCarryLength(work, THINK_OPEN)
        if (keep > 0) {
          visible += work.slice(0, -keep)
          tagCarry = work.slice(-keep)
        } else {
          visible += work
        }
        work = ''
      }
      pushVisible(visible)
    },
    flush(canEmit: boolean): void {
      if (!suppressed && !inThink && tagCarry) {
        const leftover = tagCarry
        tagCarry = ''
        pushVisible(leftover)
      }
      if (canEmit && !suppressed && !streamFlushed && stepBuf) {
        streamFlushed = true
        const ready = stepBuf
        stepBuf = ''
        onStream?.({ kind: 'delta', text: ready })
      }
    },
    get raw(): string {
      return rawAll
    },
    get wasFlushed(): boolean {
      return streamFlushed
    }
  }
}

function hasHallucinatedUnsearchedImages(response: string, shownIds: ReadonlySet<number>): boolean {
  if (/(?:给用户看了\s*\d+\s*张|找到\s*\d+\s*张|(?:找到啦|找到了)[！!，,。\s]*(?:这几张|下面这|给你看看))/u.test(response)) {
    return true
  }
  for (const m of response.matchAll(/#(\d+)\b/gu)) {
    const id = Number(m[1])
    if (Number.isInteger(id) && id > 0 && !shownIds.has(id)) {
      return true
    }
  }
  return false
}

function dedupTrailingNarration(finalText: string, stateRef: { current: HarnessState }): void {
  const blocks = stateRef.current.blocks
  const last = blocks.at(-1)
  if (last?.type !== 'narration') return
  const normFinal = normalizeForDedup(finalText)
  const normLast = normalizeForDedup(last.text)
  if (!normFinal || !normLast) return
  if (normLast === normFinal || normFinal.includes(normLast)) {
    stateRef.current = { ...stateRef.current, blocks: blocks.slice(0, -1) }
  }
}

function appendBlock(stateRef: { current: HarnessState }, block: AiTimelineBlock): void {
  stateRef.current = {
    ...stateRef.current,
    blocks: [...stateRef.current.blocks, block]
  }
}

function emitNarration(
  rawContent: string | null | undefined,
  stateRef: { current: HarnessState },
  onStream?: StreamCallback
): void {
  const text = (rawContent ?? '').trim()
  if (!text) return
  appendBlock(stateRef, { type: 'narration', text })
  onStream?.({ kind: 'narration_commit', text })
}

function startAction(
  actionId: string,
  toolName: string,
  summary: string,
  stateRef: { current: HarnessState },
  onStream?: StreamCallback
): void {
  const block: AiTimelineBlock = { type: 'action', id: actionId, tool: toolName, summary, status: 'running' }
  appendBlock(stateRef, block)
  onStream?.({ kind: 'action_start', actionId, tool: toolName, summary, status: 'running', block })
}

function finishAction(
  actionId: string,
  toolName: string,
  summary: string,
  status: 'done' | 'failed' | 'aborted',
  stateRef: { current: HarnessState },
  onStream?: StreamCallback
): void {
  const block: AiTimelineBlock = { type: 'action', id: actionId, tool: toolName, summary, status }
  stateRef.current = {
    ...stateRef.current,
    blocks: stateRef.current.blocks.map((b) => (b.type === 'action' && b.id === actionId ? block : b))
  }
  onStream?.({ kind: 'action_end', actionId, tool: toolName, summary, status, block })
}

function emitMemoryNoticeIfUpdated(
  prevNotices: string[] | undefined,
  state: HarnessState,
  onStream?: StreamCallback
): void {
  const nextNotices = state.memoryNotices
  if (!nextNotices?.length) return
  if (prevNotices === nextNotices || prevNotices?.length === nextNotices.length) return
  onStream?.({
    kind: 'memory_notice',
    memoryNotice: {
      notices: nextNotices,
      ...(state.memoryNoticeAction ? { action: state.memoryNoticeAction } : {})
    }
  })
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError')
}

function markRunningActionsAborted(stateRef: { current: HarnessState }, onStream?: StreamCallback): void {
  const running = stateRef.current.blocks.filter(
    (b): b is Extract<AiTimelineBlock, { type: 'action' }> => b.type === 'action' && b.status === 'running'
  )
  if (!running.length) return
  stateRef.current = {
    ...stateRef.current,
    blocks: stateRef.current.blocks.map((b) =>
      b.type === 'action' && b.status === 'running' ? { ...b, status: 'aborted' as const } : b
    )
  }
  for (const b of running) {
    const abortedBlock: AiTimelineBlock = { ...b, status: 'aborted' }
    onStream?.({
      kind: 'action_end',
      actionId: b.id,
      tool: b.tool,
      summary: b.summary,
      status: 'aborted',
      block: abortedBlock
    })
  }
}

function needsStepRepair(toolName: string | null, parsed: unknown, state: HarnessState): boolean {
  if (state.awaitingContrast) return true
  if (isToolError(parsed)) return true
  if (
    toolName === 'search_images' &&
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed)
  ) {
    const obj = parsed as Record<string, unknown>
    if (obj.total === 0 && Array.isArray(obj.closestTags) && obj.closestTags.length > 0) {
      return true
    }
  }
  return false
}

// 图片附件直通视觉问答与按图找相似（共用 DeepSeek-V4.1-Flash 主前缀缓存与动态人格引擎）
export async function runVisionTurn(
  conversation: AiConversationEntity,
  turns: HistoryTurn[],
  history: AiMessageEntity[],
  user: AiMessageEntity,
  env: ToolEnv,
  stateRef: { current: HarnessState },
  scopeName: string | null,
  callModel: typeof chatCall,
  image: Extract<StoredAttachment, { kind: 'image' }>,
  onStream?: StreamCallback
): Promise<{ text: string; state: HarnessState; interrupted?: boolean }> {
  if (env.signal?.aborted) {
    return { text: '', state: stateRef.current, interrupted: true }
  }
  const u = user.content as UserContent
  const question = [userText(u), env.referenceNotes].filter(Boolean).join('\n\n')
  const url = await prepareRatedUpload(image.dataUrl, image.originalHash)
  const allowedTagSet = new Set(env.tags.filter((t) => t.general).map((t) => t.name))
  const { text: profile, includedTags } = await profileSnapshotForConversation(conversation.profileVersion, true, allowedTagSet)
  const memories = await relevantMemories(u.text)
  const addedTags = env.tags
    .filter((t) => t.general && !includedTags.has(t.name))
    .map((t) => t.name)
    .slice(-40)
  const assistantRows = history.filter((m) => m.role === 'ASSISTANT')
  const recentAssistantTexts = assistantRows.slice(-4).map((m) => replyText(m.content as AssistantContent))
  const previousInterrupted = (assistantRows.at(-1)?.content as AssistantContent | undefined)?.interrupted === true

  const tools =
    (u.attachments?.length ?? (u.attachment || u.image ? 1 : 0)) === 1
      ? [
          {
            type: 'function',
            function: {
              name: 'search_similar_image',
              description: '仅在用户要求查找图库中相似的图片时调用。',
              parameters: { type: 'object', properties: {} }
            }
          }
        ]
      : undefined
  const prefixLen = 1 + PERSONA_FEW_SHOT_MESSAGES.length
  const fixedBytes =
    Buffer.byteLength(ASSISTANT_RULES + profile + JSON.stringify(PERSONA_FEW_SHOT_MESSAGES) + JSON.stringify(tools ?? [])) + 1024
  const initialTail = buildTurnTail(
    question,
    scopeName,
    u.includeR18,
    new Date(),
    memories.map((m) => `#${m.id} ${m.content}`),
    undefined,
    {
      recentAssistantTexts,
      previousInterrupted,
      addedTags,
      includeOrganized: env.includeOrganized,
      isFirstTurn: history.length === 0,
      compacted: turns.some((t) => Boolean(t.summary)),
      turnCount: turns.length,
      imageUrls: [url]
    }
  )
  const histRes = await workingHistory(turns, fixedBytes + tailBytes(initialTail), false, env.compactionProgress)
  if (histRes.compactedUpToMessageId) {
    onStream?.({ kind: 'compacted', messageId: histRes.compactedUpToMessageId })
  }
  const finalTail = histRes.changed
    ? buildTurnTail(
        question,
        scopeName,
        u.includeR18,
        new Date(),
        memories.map((m) => `#${m.id} ${m.content}`),
        undefined,
        {
          recentAssistantTexts,
          previousInterrupted,
          addedTags,
          includeOrganized: env.includeOrganized,
          isFirstTurn: history.length === 0,
          compacted: true,
          turnCount: turns.length,
          imageUrls: [url]
        }
      )
    : initialTail
  if (env.signal?.aborted) {
    return { text: '', state: stateRef.current, interrupted: true }
  }
  const built = buildMessages({
    rules: ASSISTANT_RULES,
    profile,
    examples: PERSONA_FEW_SHOT_MESSAGES,
    history: histRes.messages,
    tail: [],
    cache: true
  })
  const fitted = fitContext(built.slice(0, prefixLen), built.slice(prefixLen), finalTail, tools)
  const streamFilter = createThinkingStreamFilter(onStream)
  let res: Awaited<ReturnType<typeof chatCall>>
  try {
    res = await callModel({
      kind: 'chat',
      model: BAILIAN_CONFIG.assistantChatModel,
      messages: fitted.messages,
      tools,
      enableThinking: false,
      maxTokens: fitted.maxTokens,
      ...(env.signal ? { signal: env.signal } : {}),
      ...(onStream ? { onDelta: (delta: string) => streamFilter.onDelta(delta) } : {})
    })
  } catch (err) {
    if (isAbortError(err, env.signal)) {
      markRunningActionsAborted(stateRef, onStream)
      return { text: stripThinkTags(streamFilter.raw).trim(), state: stateRef.current, interrupted: true }
    }
    throw err
  }
  stateRef.current = {
    ...stateRef.current,
    contextUsage: contextUsage(res.usage, fitted.inputBound, res.message),
    memoryIds: memories.map((m) => m.id)
  }
  if (env.signal?.aborted) {
    return { text: stripThinkTags(res.message.content ?? streamFilter.raw).trim(), state: stateRef.current, interrupted: true }
  }
  if (tools && res.message.tool_calls?.some((c) => c.type === 'function' && c.function.name === 'search_similar_image')) {
    const cleanStepText = stripThinkTags(res.message.content ?? '').trim()
    if (!isLeakedThinking(cleanStepText)) {
      emitNarration(cleanStepText, stateRef, onStream)
    }
    const actionId = 'vision-search-similar'
    startAction(actionId, 'search_similar_image', '按图找相似', stateRef, onStream)
    let imageIds: number[]
    try {
      imageIds = await searchByImage(image, env.dirs, env.includeOrganized)
    } catch (err) {
      if (isAbortError(err, env.signal)) {
        markRunningActionsAborted(stateRef, onStream)
        return { text: '', state: stateRef.current, interrupted: true }
      }
      throw err
    }
    finishAction(actionId, 'search_similar_image', `按图找相似 · ${imageIds.length} 张`, 'done', stateRef, onStream)
    const evidence: MatchEvidence = { methods: Object.fromEntries(imageIds.map((id) => [id, 'vector'])) }
    const incomplete = (await missingSearchVector(EMBEDDING_CONFIG.model, { dirs: env.dirs, includeOrganized: env.includeOrganized, tagGroups: [], keywordGroups: [] }))
      ? '部分图片尚无画面向量'
      : undefined
    stateRef.current = {
      ...stateRef.current,
      lastSearch: {
        outcome: { imageIds, ordinaryIds: imageIds, evidence, incomplete },
        conds: [['画面', '与附件相似']]
      }
    }
    if (env.signal?.aborted) {
      return { text: localReply(imageIds.length), state: stateRef.current, interrupted: true }
    }
    return { text: localReply(imageIds.length), state: stateRef.current }
  }
  streamFilter.flush(true)
  return { text: stripThinkTags(res.message.content ?? '').trim(), state: stateRef.current }
}

interface PreparedToolCall {
  callId: string
  actionId: string
  toolName: string | null
  tool: RegisteredTool | undefined
  rawArgs: string
  argsObj: Record<string, unknown>
  startSummary: string
  blockedResult?: { content: string; status: 'done' | 'failed'; summary: string; isDuplicate?: boolean }
}

// Claude Code 范式单主循环：固定四层前缀 + 零成本微压缩 + 声明式工具归约 + 交错叙事时间线 + 自适应思考
export async function runAgentLoop(
  conversation: AiConversationEntity,
  turns: HistoryTurn[],
  history: AiMessageEntity[],
  user: AiMessageEntity,
  env: ToolEnv,
  stateRef: { current: HarnessState },
  scopeName: string | null,
  callModel: typeof chatCall,
  onStream?: StreamCallback
): Promise<{ text: string; state: HarnessState; interrupted?: boolean }> {
  const u = user.content as UserContent
  const question = [userText(u), env.referenceNotes].filter(Boolean).join('\n\n')
  const allowedTagSet = new Set(env.tags.filter((t) => t.general).map((t) => t.name))
  const { text: profile, includedTags } = await profileSnapshotForConversation(
    conversation.profileVersion,
    true,
    allowedTagSet
  )
  // 若本段对话开始后用户又在类目录里确认了新标签，只在第④层注入紧凑增量，不破坏①②层缓存前缀
  const addedTags = env.tags
    .filter((t) => t.general && !includedTags.has(t.name))
    .map((t) => t.name)
    .slice(-40)
  const memories = await relevantMemories(u.text)
  const turnEnv: ToolEnv = {
    ...env,
    preferenceIds: memories.filter((m) => m.kind === 'preference').map((m) => m.id)
  }
  stateRef.current = {
    ...stateRef.current,
    memoryIds: memories.map((m) => m.id)
  }
  if (turnEnv.signal?.aborted) {
    return { text: '', state: stateRef.current, interrupted: true }
  }
  let sessionState: string | undefined
  if (turnEnv.shownImages?.length) {
    const ordinaryRecent = turnEnv.shownImages
      .filter((img): img is { id: number; name: string } => typeof img.name === 'string' && img.name.length > 0)
      .slice(0, 6)
    const sample = ordinaryRecent.length
      ? `；近期非 R-18 图片：${ordinaryRecent.map((img) => `#${img.id}「${img.name}」`).join('、')}`
      : ''
    sessionState = `[会话状态] 本段对话已展示过 ${turnEnv.shownImages.length} 张图${sample}。若用户说“还有其他的吗”“换几张”“看过了”“再找别的”等想看没展示过的图，调用 search_images 时请设 excludeShown: true。`
  }
  const assistantRows = history.filter((m) => m.role === 'ASSISTANT')
  const recentAssistantTexts = assistantRows.slice(-4).map((m) => replyText(m.content as AssistantContent))
  const previousInterrupted = (assistantRows.at(-1)?.content as AssistantContent | undefined)?.interrupted === true
  let compactedContext = turns.some((t) => Boolean(t.summary))
  const tail: PromptMessage[] = buildTurnTail(
    question,
    scopeName,
    u.includeR18,
    new Date(),
    memories.map((m) => `#${m.id} ${m.content}`),
    sessionState,
    {
      recentAssistantTexts,
      previousInterrupted,
      addedTags,
      includeOrganized: turnEnv.includeOrganized,
      isFirstTurn: history.length === 0,
      compacted: compactedContext,
      turnCount: turns.length,
      imageUrls: turnEnv.referenceImageUrls
    }
  )
  const fixedBytes =
    Buffer.byteLength(ASSISTANT_RULES + profile + JSON.stringify(PERSONA_FEW_SHOT_MESSAGES) + JSON.stringify(ASSISTANT_TOOLS)) + 1024
  const seenCallKeys = new Set<string>()
  const shownIdSet = new Set((turnEnv.shownImages ?? []).map((img) => img.id))
  let previousStepNeedsRepair = false
  let repairedHallucination = false
  let turnLibVer = getLibraryVersion()
  const injectedAddedTags = new Set<string>(addedTags)

  for (let step = 0; step < MAX_STEPS; step++) {
    if (turnEnv.signal?.aborted) {
      markRunningActionsAborted(stateRef, onStream)
      return { text: '', state: stateRef.current, interrupted: true }
    }
    if (step > 0) {
      const currentLibVer = getLibraryVersion()
      if (currentLibVer !== turnLibVer) {
        turnLibVer = currentLibVer
        const freshDict = await loadDictionary(turnEnv.includeOrganized)
        turnEnv.tags = freshDict.tags
        const midTurnNewTags = freshDict.tags
          .filter((t) => t.general && !includedTags.has(t.name) && !injectedAddedTags.has(t.name))
          .map((t) => t.name)
          .slice(-40)
        if (midTurnNewTags.length) {
          for (const tagName of midTurnNewTags) injectedAddedTags.add(tagName)
          tail.push({
            role: 'system',
            content: `[图库实时新增] 回答过程中有新整理的已确认图片入库，新增可用标签：${midTurnNewTags.join('、')}。`
          })
        }
      }
    }
    const compactTail = microcompactTail(tail)
    let past: PromptMessage[]
    let res: Awaited<ReturnType<typeof chatCall>>
    let fitted: ReturnType<typeof fitContext>
    const afterProposal = step === 0 && turnEnv.previousProposal !== undefined && history.at(-1)?.id === turnEnv.previousProposal.messageId
    const streamed = Boolean(onStream && !afterProposal)
    const streamFilter = createThinkingStreamFilter(streamed ? onStream : undefined)
    const enableThinking = step > 0 && previousStepNeedsRepair

    try {
      const histRes = await workingHistory(turns, fixedBytes + tailBytes(compactTail), false, turnEnv.compactionProgress)
      past = histRes.messages
      if (histRes.compactedUpToMessageId) {
        onStream?.({ kind: 'compacted', messageId: histRes.compactedUpToMessageId })
      }
      if (histRes.changed && !compactedContext) {
        compactedContext = true
        tail.push({
          role: 'system',
          content:
            '[诺诺核心锚点] 你是白发紫瞳、右鬓别粉色五瓣花夹的毒舌可爱猫娘诺诺；无论聊了多少轮或刚压缩过上下文，都保持微信熟人短句大白话与高攻低防反差，绝不退回客服腔或舞台腔。'
        })
      }
      const finalCompactTail = histRes.changed ? microcompactTail(tail) : compactTail
      const built = buildMessages({
        rules: ASSISTANT_RULES,
        profile,
        examples: PERSONA_FEW_SHOT_MESSAGES,
        history: past,
        tail: [],
        cache: true
      })
      const prefixLen = 1 + PERSONA_FEW_SHOT_MESSAGES.length
      fitted = fitContext(built.slice(0, prefixLen), built.slice(prefixLen), finalCompactTail, ASSISTANT_TOOLS)
      const requestMessages = step > 0 ? markStepCache(fitted.messages) : fitted.messages
      if (turnEnv.signal?.aborted) {
        markRunningActionsAborted(stateRef, onStream)
        return { text: '', state: stateRef.current, interrupted: true }
      }
      res = await callModel({
        kind: 'chat',
        model: BAILIAN_CONFIG.assistantChatModel,
        messages: requestMessages,
        tools: ASSISTANT_TOOLS,
        ...(afterProposal ? { requiredTool: 'propose_category_change' } : {}),
        ...(enableThinking ? { enableThinking: true, thinkingBudget: 512 } : { enableThinking: false }),
        maxTokens: fitted.maxTokens,
        ...(turnEnv.signal ? { signal: turnEnv.signal } : {}),
        ...(streamed ? { onDelta: (text: string) => streamFilter.onDelta(text) } : {})
      })
    } catch (err) {
      if (isAbortError(err, turnEnv.signal)) {
        markRunningActionsAborted(stateRef, onStream)
        return { text: stripThinkTags(streamFilter.raw).trim(), state: stateRef.current, interrupted: true }
      }
      throw err
    }

    stateRef.current = { ...stateRef.current, contextUsage: contextUsage(res.usage, fitted.inputBound, res.message) }
    const calls = res.message.tool_calls ?? []

    if (turnEnv.signal?.aborted) {
      const cleanedAbort = stripThinkTags(res.message.content ?? streamFilter.raw)
      if (calls.length > 0) {
        if (!isLeakedThinking(res.message.content ?? streamFilter.raw)) {
          emitNarration(cleanedAbort, stateRef, onStream)
        }
        return { text: '', state: stateRef.current, interrupted: true }
      }
      return { text: cleanedAbort.trim(), state: stateRef.current, interrupted: true }
    }

    // 目录操作的执行结果由本地回执提供。服务异常返回自由文本时也不能把它作为磁盘操作结果展示。
    if (afterProposal && (calls.length !== 1 || calls[0].type !== 'function' || calls[0].function.name !== 'propose_category_change')) {
      return { text: await previousReceipt(turnEnv), state: stateRef.current }
    }

    if (calls.length === 0) {
      const response = stripThinkTags(res.message.content ?? '').trim()
      if (stateRef.current.awaitingContrast) {
        if (!isLeakedThinking(res.message.content ?? '')) {
          emitNarration(response, stateRef, onStream)
        }
        const actionId = `s${step}-awaiting-contrast`
        const searchTool = ASSISTANT_TOOL_MAP.get('search_images')
        const startSummary = searchTool?.formatStart?.({}) ?? '检索图库'
        startAction(actionId, 'search_images', startSummary, stateRef, onStream)
        const fallback = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', '{}', turnEnv, stateRef.current)
        const doneSummary = searchTool?.formatDone?.({}, fallback) ?? startSummary
        finishAction(
          actionId,
          'search_images',
          doneSummary,
          isToolError(parseToolJson(fallback.content)) ? 'failed' : 'done',
          stateRef,
          onStream
        )
        stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', fallback.outcome)
        return { text: localReply(stateRef.current.lastSearch?.outcome.imageIds.length ?? 0), state: stateRef.current }
      }
      // 通用幻觉拦截：无附件时如果模型未调用 search_images 就编造“找到啦/找到 N 张/未展示 #编号”，先让模型纠偏重搜，末步兜底强制核对
      if (!turnEnv.hasInputContext && !stateRef.current.lastSearch && hasHallucinatedUnsearchedImages(response, shownIdSet)) {
        if (!repairedHallucination && step < MAX_STEPS - 1) {
          repairedHallucination = true
          previousStepNeedsRepair = true
          if (streamed && stateRef.current.blocks.length === 0 && streamFilter.wasFlushed) {
            onStream?.({ kind: 'reset' })
          }
          tail.push(
            { role: 'assistant', content: response },
            {
              role: 'user',
              content:
                '[系统纠偏] 你刚才没有调用 search_images 就声称找到了图片或列出了未检索的图片编号。请立即调用 search_images（看新图时设 excludeShown: true）按真实图库检索，拿到工具结果后再用诺诺口吻简洁回复，不要列 #编号。'
            }
          )
          continue
        }
        if (streamed && stateRef.current.blocks.length === 0 && streamFilter.wasFlushed) {
          onStream?.({ kind: 'reset' })
        }
        const actionId = `s${step}-hallucination-check`
        const checkArgs = { semantic: turnEnv.query }
        const searchTool = ASSISTANT_TOOL_MAP.get('search_images')
        const startSummary = searchTool?.formatStart?.(checkArgs) ?? '检索图库'
        startAction(actionId, 'search_images', startSummary, stateRef, onStream)
        const check = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', JSON.stringify(checkArgs), turnEnv, stateRef.current)
        const doneSummary = searchTool?.formatDone?.(checkArgs, check) ?? startSummary
        finishAction(
          actionId,
          'search_images',
          doneSummary,
          isToolError(parseToolJson(check.content)) ? 'failed' : 'done',
          stateRef,
          onStream
        )
        stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', check.outcome)
        if (stateRef.current.awaitingContrast) {
          previousStepNeedsRepair = true
          tail.push({ role: 'user', content: check.content })
          continue
        }
      }
      if (streamed && response) {
        streamFilter.flush(true)
      }
      dedupTrailingNarration(response, stateRef)
      return { text: response, state: stateRef.current }
    }

    const prepared: PreparedToolCall[] = calls.map((call, idx) => {
      const fn = call.type === 'function' ? call.function : null
      const toolName = fn?.name ?? null
      const tool = toolName ? ASSISTANT_TOOL_MAP.get(toolName) : undefined
      const rawArgs = fn?.arguments ?? '{}'
      const argsObj = fn ? parseArgsObject(rawArgs) : {}
      const startSummary = tool?.formatStart?.(argsObj) ?? '执行操作'
      const actionId = `s${step}-${idx}-${call.id || 'call'}`

      if (!fn) {
        return {
          callId: call.id,
          actionId,
          toolName: null,
          tool: undefined,
          rawArgs,
          argsObj,
          startSummary,
          blockedResult: {
            content: JSON.stringify({ error: '不支持的调用' }),
            status: 'failed',
            summary: `${startSummary} · 不支持的调用`
          }
        }
      }
      if (fn.name === 'reply_with_followup' && (calls.length !== 1 || stateRef.current.lastSearch || stateRef.current.awaitingContrast)) {
        return {
          callId: call.id,
          actionId,
          toolName,
          tool,
          rawArgs,
          argsObj,
          startSummary,
          blockedResult: {
            content: '请先完成当前操作，再根据实际结果直接回答。',
            status: 'failed',
            summary: `${startSummary} · 需先完成前置操作`
          }
        }
      }
      const callKey = normalizeToolCallKey(fn.name, rawArgs)
      if (seenCallKeys.has(callKey)) {
        return {
          callId: call.id,
          actionId,
          toolName,
          tool,
          rawArgs,
          argsObj,
          startSummary,
          blockedResult: {
            content: JSON.stringify({
              warning: '本轮已经用完全相同的参数调用过该工具，请直接根据已有工具结果回复用户，或换用不同参数。'
            }),
            status: 'failed',
            summary: `${startSummary} · 重复跳过`,
            isDuplicate: true
          }
        }
      }
      seenCallKeys.add(callKey)
      return { callId: call.id, actionId, toolName, tool, rawArgs, argsObj, startSummary }
    })

    // 静默内部工具（如 reply_with_followup）即使被拦截也不把同轮正文固化或暴露为过程步骤
    const rawToolStepText = res.message.content ?? ''
    const cleanToolStepText = stripThinkTags(rawToolStepText).trim()
    const onlySilentTools = prepared.every((item) => item.tool?.silent)
    const callingSearchBeforeResult =
      !stateRef.current.lastSearch && prepared.some((item) => item.toolName === 'search_images' && !item.blockedResult)
    const suppressedPrematureClaim = callingSearchBeforeResult && isPrematureSearchClaim(cleanToolStepText)
    const suppressedLeakedThinking = isLeakedThinking(rawToolStepText)
    if (!onlySilentTools && !suppressedPrematureClaim && !suppressedLeakedThinking) {
      // 交错叙事：绝不在 tool_calls 前发送 reset 擦除已输出的过渡念白，而是固化为 narration_commit
      emitNarration(cleanToolStepText, stateRef, onStream)
    }
    tail.push({
      role: 'assistant',
      content: rawToolStepText,
      ...(res.reasoningContent ? { reasoning_content: res.reasoningContent } : {}),
      tool_calls: calls
    })

    const isVisibleAction = (item: PreparedToolCall): boolean => !item.tool?.silent

    let stepNeedsRepair = false
    const finalizeItem = (
      item: PreparedToolCall,
      executed: ToolExecutionResult,
      mergeSearch = false
    ): { text: string; state: HarnessState; interrupted?: boolean } | null => {
      const parsed = parseToolJson(executed.content)
      const isErr = item.blockedResult ? item.blockedResult.status === 'failed' : !item.tool || isToolError(parsed)
      const status: 'done' | 'failed' = isErr ? 'failed' : 'done'
      const summary = item.blockedResult
        ? item.blockedResult.summary
        : item.tool?.formatDone?.(item.argsObj, executed) ?? item.startSummary
      if (isVisibleAction(item)) {
        finishAction(item.actionId, item.toolName ?? 'unknown', summary, status, stateRef, onStream)
      }

      if (item.toolName && !item.blockedResult) {
        const prevNotices = stateRef.current.memoryNotices
        stateRef.current = reduceToolOutcome(stateRef.current, item.toolName, executed.outcome, { mergeSearch })
        emitMemoryNoticeIfUpdated(prevNotices, stateRef.current, onStream)
      }
      if (item.blockedResult?.isDuplicate || needsStepRepair(item.toolName, parsed, stateRef.current)) {
        stepNeedsRepair = true
      }
      tail.push({ role: 'tool', tool_call_id: item.callId, content: executed.content })

      if (stateRef.current.discussionReply) {
        dedupTrailingNarration(stateRef.current.discussionReply.text, stateRef)
        return { text: stateRef.current.discussionReply.text, state: stateRef.current }
      }
      if (stateRef.current.directoryProposal) {
        return { text: stateRef.current.directoryProposal.text, state: stateRef.current }
      }
      if (stateRef.current.exclusionReply) {
        return { text: stateRef.current.exclusionReply.text, state: stateRef.current }
      }
      return null
    }

    const allReadOnly =
      prepared.length > 1 && prepared.every((item) => item.tool?.sideEffect === 'read')
    if (allReadOnly) {
      for (const item of prepared) {
        if (isVisibleAction(item)) {
          startAction(item.actionId, item.toolName ?? 'unknown', item.startSummary, stateRef, onStream)
        }
      }
      const snapshotState = stateRef.current
      let results: ToolExecutionResult[]
      try {
        results = await Promise.all(
          prepared.map(async (item) =>
            item.blockedResult
              ? { content: item.blockedResult.content }
              : dispatchTool(ASSISTANT_TOOL_MAP, item.toolName!, item.rawArgs, turnEnv, snapshotState)
          )
        )
      } catch (err) {
        if (isAbortError(err, turnEnv.signal)) {
          markRunningActionsAborted(stateRef, onStream)
          return { text: '', state: stateRef.current, interrupted: true }
        }
        throw err
      }
      let mergedSearchInStep = false
      for (let i = 0; i < prepared.length; i++) {
        const isSearch = prepared[i].toolName === 'search_images' && !prepared[i].blockedResult
        const earlyReturn = finalizeItem(prepared[i], results[i], isSearch && mergedSearchInStep)
        if (isSearch) mergedSearchInStep = true
        if (earlyReturn) {
          return turnEnv.signal?.aborted ? { ...earlyReturn, interrupted: true } : earlyReturn
        }
      }
      if (turnEnv.signal?.aborted) {
        markRunningActionsAborted(stateRef, onStream)
        return { text: '', state: stateRef.current, interrupted: true }
      }
    } else {
      for (const item of prepared) {
        if (turnEnv.signal?.aborted) {
          markRunningActionsAborted(stateRef, onStream)
          return { text: '', state: stateRef.current, interrupted: true }
        }
        if (isVisibleAction(item)) {
          startAction(item.actionId, item.toolName ?? 'unknown', item.startSummary, stateRef, onStream)
        }
        let executed: ToolExecutionResult
        try {
          executed = item.blockedResult
            ? { content: item.blockedResult.content }
            : await dispatchTool(ASSISTANT_TOOL_MAP, item.toolName!, item.rawArgs, turnEnv, stateRef.current)
        } catch (err) {
          if (isAbortError(err, turnEnv.signal)) {
            markRunningActionsAborted(stateRef, onStream)
            return { text: '', state: stateRef.current, interrupted: true }
          }
          throw err
        }
        const earlyReturn = finalizeItem(item, executed)
        if (earlyReturn) {
          return turnEnv.signal?.aborted ? { ...earlyReturn, interrupted: true } : earlyReturn
        }
        if (turnEnv.signal?.aborted) {
          markRunningActionsAborted(stateRef, onStream)
          return { text: '', state: stateRef.current, interrupted: true }
        }
      }
    }

    previousStepNeedsRepair = stepNeedsRepair
  }

  // 步数用完还在调工具：按最后一次检索给个模板回复
  if (stateRef.current.awaitingContrast && !turnEnv.signal?.aborted) {
    const actionId = 'final-awaiting-contrast'
    const searchTool = ASSISTANT_TOOL_MAP.get('search_images')
    const startSummary = searchTool?.formatStart?.({}) ?? '检索图库'
    startAction(actionId, 'search_images', startSummary, stateRef, onStream)
    const fallback = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', '{}', turnEnv, stateRef.current)
    const doneSummary = searchTool?.formatDone?.({}, fallback) ?? startSummary
    finishAction(
      actionId,
      'search_images',
      doneSummary,
      isToolError(parseToolJson(fallback.content)) ? 'failed' : 'done',
      stateRef,
      onStream
    )
    stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', fallback.outcome)
  }
  return {
    text: stateRef.current.lastSearch ? localReply(stateRef.current.lastSearch.outcome.imageIds.length) : '这次查询还没有完成。',
    state: stateRef.current,
    ...(turnEnv.signal?.aborted ? { interrupted: true } : {})
  }
}
