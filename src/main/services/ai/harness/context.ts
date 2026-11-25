import type { AiContextUsage } from '@shared/api'
import { findVocabulary } from '../../../repositories/aiSearchRepository'
import { findCompactionMap, type AiConversationEntity, type AiMessageEntity } from '../../../repositories/aiConversationRepository'
import { ASSISTANT_RULES, cardCaption } from '../assistantPrompt'
import { proposalStatesInHistory } from '../categoryProposalService'
import { fitContext, messageBound } from '../contextWindow'
import { summaryMessages, type HistoryTurn } from '../conversationCompaction'
import { profileOfConversation } from '../profileService'
import { buildMessages, type PromptMessage } from '../promptPrefix'
import { ASSISTANT_TOOLS } from './tools'
import { replyText, userText, type AssistantContent, type PreviousSearchState, type UserContent } from './types'

const MICROCOMPACT_TOOL_BYTES = 2048

// Claude Code 式零成本微压缩：多步工具往返中保留最近一组工具原始返回，把更早步骤里过长的 tool 结果就地折叠为简短摘要
export function microcompactTail(tail: PromptMessage[], maxToolBytes = MICROCOMPACT_TOOL_BYTES): PromptMessage[] {
  const lastAssistantIdx = tail.findLastIndex((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
  if (lastAssistantIdx <= 0) {
    return tail
  }
  let changed = false
  const next = tail.map((msg, idx) => {
    if (idx >= lastAssistantIdx || msg.role !== 'tool' || typeof msg.content !== 'string') {
      return msg
    }
    const bytes = Buffer.byteLength(msg.content)
    if (bytes <= maxToolBytes) {
      return msg
    }
    changed = true
    return {
      ...msg,
      content: JSON.stringify({
        compacted: true,
        preview: msg.content.slice(0, 160),
        originalBytes: bytes
      })
    }
  })
  return changed ? next : tail
}

export async function historyTurns(history: AiMessageEntity[]): Promise<{
  turns: HistoryTurn[]
  previousResults?: PreviousSearchState
}> {
  const turns: HistoryTurn[] = []
  let question: PromptMessage | undefined
  let previousResults: PreviousSearchState | undefined
  const proposalStates = await proposalStatesInHistory(
    history.flatMap((row) => {
      const id = (row.content as AssistantContent).categoryProposalId
      return row.role === 'ASSISTANT' && id ? [id] : []
    })
  )
  const compactions = await findCompactionMap(
    history.flatMap((row) => (row.role === 'ASSISTANT' ? [row.id] : []))
  )
  let previousIncludeR18 = false
  let previousScope: UserContent['scope'] = null
  for (const m of history) {
    if (m.role === 'USER') {
      const uc = m.content as UserContent
      previousIncludeR18 = uc.includeR18 === true
      previousScope = uc.scope ?? null
      question = { role: 'user', content: userText(uc) }
    } else if (m.role === 'ASSISTANT') {
      const c = m.content as AssistantContent
      const summary = compactions.get(m.id) ?? c.compactSummary
      if (c.how) {
        previousResults = {
          ids: c.imageIds ?? [],
          includeR18: previousIncludeR18,
          scope: previousScope,
          evidence: c.evidence,
          incomplete: c.incomplete
        }
      }
      // 图片详情可能已改分级。仅保留用户的问题及安全的卡片文案，避免把内部占位符当成诺诺的话。
      let text = c.how || c.readLibraryMetadata ? (c.how && c.imageIds?.length ? cardCaption(c.imageIds.length, undefined, 'search') : '') : replyText(c)
      if (!text || /^已查询图库[。.!！]?$/u.test(text.trim())) {
        // 保留用户原话。会随分级变化的图片详情只在本轮重新读取，不写入摘要。
        const messages: PromptMessage[] = question
          ? [question, { role: 'assistant', content: c.readLibraryMetadata ? '（本轮围绕图库图片作了回答。）' : '（本轮查询了图库。）' }]
          : []
        turns.push({ id: m.id, messages, summary })
        question = undefined
        continue
      }
      if (c.categoryProposalId) text += `\n[软件记录] 目录提案当前状态：${proposalStates.get(c.categoryProposalId) ?? '未知'}。`
      if (question) turns.push({ id: m.id, messages: [question, { role: 'assistant', content: text }], summary })
      question = undefined
    }
  }
  return { turns, previousResults }
}

// 第④层：当前时间、范围、是否包含 R-18、检索到的记忆，加上这句话
export function buildTurnTail(text: string, scope: string | null, includeR18: boolean, now: Date, memories: string[]): PromptMessage[] {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const memo = memories.length ? `\n[软件附注] 记得的偏好：\n${memories.map((m) => `- ${m}`).join('\n')}` : ''
  return [
    { role: 'system', content: `当前时间 ${time}。图库工具范围为${scope ? `「${scope}」` : '全部类目录'}，${includeR18 ? '包含' : '不包含'} R-18。${memo}` },
    { role: 'user', content: text }
  ]
}

export function tailBytes(tail: PromptMessage[]): number {
  return tail.reduce((n, m) => n + messageBound(m), 0)
}

// 精简结束时还没有下一次模型账单，按实际会话前缀、工具定义和保留的消息估算。
export async function estimateCompactedUsage(conversation: AiConversationEntity, history: PromptMessage[]): Promise<AiContextUsage> {
  const tags = await findVocabulary(true)
  const profile = await profileOfConversation(
    conversation.profileVersion,
    true,
    new Set(tags.filter((t) => t.general).map((t) => t.name))
  )
  const [system, ...past] = buildMessages({ rules: ASSISTANT_RULES, profile, history, tail: [], cache: true })
  return { usedTokens: fitContext([system], past, [], ASSISTANT_TOOLS).inputBound, estimated: true, compacted: true }
}

export { summaryMessages }
