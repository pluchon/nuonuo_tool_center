import type { AiStreamEvent } from '@shared/api'
import { BAILIAN_CONFIG, EMBEDDING_CONFIG, readCloudCredentials } from '../../../config/cloudConfig'
import { missingSearchVector } from '../../../repositories/aiSearchRepository'
import type { AiConversationEntity, AiMessageEntity } from '../../../repositories/aiConversationRepository'
import type { StoredAttachment } from '../assistantAttachment'
import { ASSISTANT_RULES, NUONUO_PERSONA } from '../assistantPrompt'
import type { chatCall } from '../bailianClient'
import { contextUsage, fitContext } from '../contextWindow'
import { workingHistory, type HistoryTurn } from '../conversationCompaction'
import { prepareRatedUpload } from '../embeddingService'
import { relevantMemories } from '../memoryRetrieval'
import { profileOfConversation } from '../profileService'
import { buildMessages, markStepCache, stableStringify, type PromptMessage } from '../promptPrefix'
import type { MatchEvidence } from '../searchFeedback'
import { localReply, searchByImage } from '../search/hybridSearch'
import { buildTurnTail, microcompactTail, tailBytes } from './context'
import { dispatchTool } from './toolRegistry'
import { ASSISTANT_TOOL_MAP, ASSISTANT_TOOLS } from './tools'
import { previousReceipt } from './tools/categoryTools'
import { reduceToolOutcome, userText, type HarnessState, type ToolEnv, type UserContent } from './types'

// 一次回答最多调几次模型（含工具往返）
const MAX_STEPS = 4

const TOOL_STATUS: Record<string, string> = {
  search_images: '正在检索图库…',
  get_image: '正在查看图片信息…',
  read_referenced_images: '正在查看图片信息…',
  list_tags: '正在查看标签词表…',
  list_categories: '正在核对类目录…',
  list_category_paths: '正在核对类目录…',
  propose_category_change: '正在核对类目录…',
  remember_preference: '正在记住偏好…',
  remember: '正在记住偏好…',
  explain_match: '正在核对检索结果…',
  exclude_image: '正在核对检索结果…'
}

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

// 图片附件直通视觉问答与按图找相似
export async function runVisionTurn(
  turns: HistoryTurn[],
  user: AiMessageEntity,
  env: ToolEnv,
  stateRef: { current: HarnessState },
  callModel: typeof chatCall,
  image: Extract<StoredAttachment, { kind: 'image' }>,
  onStream?: StreamCallback
): Promise<{ text: string; state: HarnessState }> {
  const u = user.content as UserContent
  const question = [userText(u), env.referenceNotes].filter(Boolean).join('\n\n')
  const url = await prepareRatedUpload(image.dataUrl, image.originalHash)
  const { messages: past } = await workingHistory(turns, Buffer.byteLength(question) + 4096, false, env.compactionProgress)
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
  const fitted = fitContext(
    [{ role: 'system', content: `${NUONUO_PERSONA}\n按照用户提供的文件和本轮要求观察所附图片，回答时遵循用户指定的格式。` }],
    past,
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: question }] }],
    tools
  )
  const res = await callModel({
    kind: 'chat',
    model: BAILIAN_CONFIG.visionSearchModel,
    messages: fitted.messages,
    tools,
    maxTokens: fitted.maxTokens,
    ...(onStream ? { onDelta: (text: string) => onStream({ kind: 'delta', text }) } : {})
  })
  stateRef.current = {
    ...stateRef.current,
    contextUsage: contextUsage(res.usage, fitted.inputBound, res.message)
  }
  if (tools && res.message.tool_calls?.some((c) => c.type === 'function' && c.function.name === 'search_similar_image')) {
    onStream?.({ kind: 'reset' })
    onStream?.({ kind: 'status', tool: 'search_similar_image', text: '正在按图找相似…' })
    const imageIds = await searchByImage(image, env.dirs)
    const evidence: MatchEvidence = { methods: Object.fromEntries(imageIds.map((id) => [id, 'vector'])) }
    const incomplete = (await missingSearchVector(EMBEDDING_CONFIG.model, { dirs: env.dirs, tagGroups: [], keywordGroups: [] }))
      ? '部分图片尚无画面向量'
      : undefined
    stateRef.current = {
      ...stateRef.current,
      lastSearch: {
        outcome: { imageIds, ordinaryIds: imageIds, evidence, incomplete },
        conds: [['画面', '与附件相似']]
      }
    }
    return { text: localReply(imageIds.length), state: stateRef.current }
  }
  return { text: (res.message.content ?? '').trim(), state: stateRef.current }
}

// Claude Code 范式单主循环：固定四层前缀 + 零成本微压缩 + 声明式工具归约 + 多步缓存断点推进
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
): Promise<{ text: string; state: HarnessState }> {
  const u = user.content as UserContent
  const question = [userText(u), env.referenceNotes].filter(Boolean).join('\n\n')
  const profile = await profileOfConversation(
    conversation.profileVersion,
    true,
    new Set(env.tags.filter((t) => t.general).map((t) => t.name))
  )
  const memories = await relevantMemories(u.text)
  const turnEnv: ToolEnv = {
    ...env,
    preferenceIds: memories.filter((m) => m.kind === 'preference').map((m) => m.id)
  }
  stateRef.current = {
    ...stateRef.current,
    memoryIds: memories.map((m) => m.id)
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
  const tail: PromptMessage[] = buildTurnTail(
    question,
    scopeName,
    u.includeR18,
    new Date(),
    memories.map((m) => `#${m.id} ${m.content}`),
    sessionState
  )
  const fixedBytes = Buffer.byteLength(ASSISTANT_RULES + profile + JSON.stringify(ASSISTANT_TOOLS)) + 1024
  const seenCallKeys = new Set<string>()

  for (let step = 0; step < MAX_STEPS; step++) {
    const compactTail = microcompactTail(tail)
    const { messages: past } = await workingHistory(turns, fixedBytes + tailBytes(compactTail), false, turnEnv.compactionProgress)
    const [system, ...historyWithMark] = buildMessages({ rules: ASSISTANT_RULES, profile, history: past, tail: [], cache: true })
    const fitted = fitContext([system], historyWithMark, compactTail, ASSISTANT_TOOLS)
    const requestMessages = step > 0 ? markStepCache(fitted.messages) : fitted.messages
    const afterProposal = step === 0 && turnEnv.previousProposal !== undefined && history.at(-1)?.id === turnEnv.previousProposal.messageId
    const streamed = Boolean(onStream && !afterProposal)

    const res = await callModel({
      kind: 'chat',
      model: BAILIAN_CONFIG.chatModel,
      messages: requestMessages,
      tools: ASSISTANT_TOOLS,
      ...(afterProposal ? { requiredTool: 'propose_category_change' } : {}),
      maxTokens: fitted.maxTokens,
      ...(streamed ? { onDelta: (text: string) => onStream!({ kind: 'delta', text }) } : {})
    })
    stateRef.current = { ...stateRef.current, contextUsage: contextUsage(res.usage, fitted.inputBound, res.message) }
    const calls = res.message.tool_calls ?? []

    // 目录操作的执行结果由本地回执提供。服务异常返回自由文本时也不能把它作为磁盘操作结果展示。
    if (afterProposal && (calls.length !== 1 || calls[0].type !== 'function' || calls[0].function.name !== 'propose_category_change')) {
      return { text: await previousReceipt(turnEnv), state: stateRef.current }
    }

    if (calls.length === 0) {
      const response = (res.message.content ?? '').trim()
      if (stateRef.current.awaitingContrast) {
        if (streamed) onStream?.({ kind: 'reset' })
        onStream?.({ kind: 'status', tool: 'search_images', text: TOOL_STATUS.search_images })
        const fallback = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', '{}', turnEnv, stateRef.current)
        stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', fallback.outcome)
        return { text: localReply(stateRef.current.lastSearch?.outcome.imageIds.length ?? 0), state: stateRef.current }
      }
      // 通用幻觉拦截：无附件时如果模型未调用 search_images 就编造“找到 N 张 / 给用户看了 N 张”，强制按原文语义核对一次
      if (!turnEnv.hasInputContext && !stateRef.current.lastSearch && /(?:给用户看了\s*\d+\s*张|找到\s*\d+\s*张)/u.test(response)) {
        if (streamed) onStream?.({ kind: 'reset' })
        onStream?.({ kind: 'status', tool: 'search_images', text: TOOL_STATUS.search_images })
        const check = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', JSON.stringify({ semantic: turnEnv.query }), turnEnv, stateRef.current)
        stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', check.outcome)
        if (stateRef.current.awaitingContrast) {
          tail.push({ role: 'user', content: check.content })
          continue
        }
      }
      return { text: response, state: stateRef.current }
    }

    if (streamed) onStream?.({ kind: 'reset' })
    tail.push({ role: 'assistant', content: res.message.content ?? '', tool_calls: calls })
    let hasDuplicateCall = false
    for (const call of calls) {
      const fn = call.type === 'function' ? call.function : null
      if (fn?.name === 'reply_with_followup' && (calls.length !== 1 || stateRef.current.lastSearch || stateRef.current.awaitingContrast)) {
        tail.push({ role: 'tool', tool_call_id: call.id, content: '请先完成当前操作，再根据实际结果直接回答。' })
        continue
      }
      if (fn) {
        const callKey = normalizeToolCallKey(fn.name, fn.arguments)
        if (seenCallKeys.has(callKey)) {
          hasDuplicateCall = true
          tail.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              warning: '本轮已经用完全相同的参数调用过该工具，请直接根据已有工具结果回复用户，或换用不同参数。'
            })
          })
          continue
        }
        seenCallKeys.add(callKey)
      }
      if (fn && onStream) {
        const statusText = TOOL_STATUS[fn.name]
        if (statusText) onStream({ kind: 'status', tool: fn.name, text: statusText })
      }
      const executed = fn
        ? await dispatchTool(ASSISTANT_TOOL_MAP, fn.name, fn.arguments, turnEnv, stateRef.current)
        : { content: JSON.stringify({ error: '不支持的调用' }) }
      if (fn) {
        stateRef.current = reduceToolOutcome(stateRef.current, fn.name, executed.outcome)
      }
      if (stateRef.current.discussionReply) {
        return { text: stateRef.current.discussionReply.text, state: stateRef.current }
      }
      if (stateRef.current.directoryProposal) {
        return { text: stateRef.current.directoryProposal.text, state: stateRef.current }
      }
      if (stateRef.current.exclusionReply) {
        return { text: stateRef.current.exclusionReply.text, state: stateRef.current }
      }
      tail.push({ role: 'tool', tool_call_id: call.id, content: executed.content })
    }

    const canShortCircuit =
      !hasDuplicateCall &&
      !stateRef.current.needsDetails &&
      stateRef.current.lastSearch &&
      (!isConversationalSearch(turnEnv.userText) || Boolean(stateRef.current.lastSearch.caption)) &&
      calls.every((call) => call.type === 'function' && call.function.name === 'search_images')
    if (canShortCircuit) {
      return { text: localReply(stateRef.current.lastSearch!.outcome.imageIds.length), state: stateRef.current }
    }
  }

  // 步数用完还在调工具：按最后一次检索给个模板回复
  if (stateRef.current.awaitingContrast) {
    const fallback = await dispatchTool(ASSISTANT_TOOL_MAP, 'search_images', '{}', turnEnv, stateRef.current)
    stateRef.current = reduceToolOutcome(stateRef.current, 'search_images', fallback.outcome)
  }
  return {
    text: stateRef.current.lastSearch ? localReply(stateRef.current.lastSearch.outcome.imageIds.length) : '这次查询还没有完成。',
    state: stateRef.current
  }
}
