import type { AiContextUsage, AiTimelineBlock } from '@shared/api'
import { findVocabulary } from '../../../repositories/aiSearchRepository'
import { findCompactionMap, type AiConversationEntity, type AiMessageEntity } from '../../../repositories/aiConversationRepository'
import { ASSISTANT_RULES } from '../assistantPrompt'
import { proposalStatesInHistory } from '../categoryProposalService'
import { fitContext, messageBound } from '../contextWindow'
import { summaryMessages, type HistoryTurn } from '../conversationCompaction'
import { profileOfConversation } from '../profileService'
import { buildMessages, type PromptMessage } from '../promptPrefix'
import { ASSISTANT_TOOLS } from './tools'
import { replyText, userText, type AssistantContent, type PreviousSearchState, type UserContent } from './types'

const MICROCOMPACT_TOOL_BYTES = 2048
const HAS_KAOMOJI_RE = /(?:ฅ[^\s]{1,8}ฅ|[（(][^\u4e00-\u9fa5a-zA-Z0-9\n]{2,12}[）)]|[≧≦ωﻌ•ᴥ▽ﾉ]{2,}|\^•ﻌ•\^)/u

function hasMiaoOrKaomoji(text: string): boolean {
  const trimmed = text.trim()
  return /喵/u.test(trimmed) || HAS_KAOMOJI_RE.test(trimmed)
}

export interface TurnTailCues {
  recentAssistantTexts?: string[]
  previousInterrupted?: boolean
  addedTags?: string[]
}

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

export async function historyTurns(history: AiMessageEntity[], currentIncludeR18 = false): Promise<{
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
      // 保留诺诺的真实口吻；仅当上轮在开启 R-18 时读取了单图元数据而本轮关闭 R-18 时做安全脱敏。
      const redactSensitive = Boolean(c.readLibraryMetadata && previousIncludeR18 && !currentIncludeR18)
      let text = redactSensitive ? '（本轮围绕图库图片作了回答。）' : replyText(c)
      if (!text.trim() || /^已查询图库[。.!！]?$/u.test(text.trim())) {
        text = c.readLibraryMetadata ? '（本轮围绕图库图片作了回答。）' : c.imageIds?.length ? '（本轮展示了图库图片。）' : ''
      }
      if (c.interrupted && c.blocks?.length) {
        const actionSummaries = redactSensitive
          ? '已执行图库操作'
          : c.blocks
              .filter((b): b is Extract<AiTimelineBlock, { type: 'action' }> => b.type === 'action')
              .map((b) => b.summary)
              .filter(Boolean)
              .join('；')
        if (actionSummaries) {
          text = text
            ? `${text}\n[软件记录] 上轮对话被主人半途打断；已执行：${actionSummaries}`
            : `[软件记录] 上轮对话被主人半途打断；已执行：${actionSummaries}`
        }
      }
      if (c.categoryProposalId) text += `\n[软件记录] 目录提案当前状态：${proposalStates.get(c.categoryProposalId) ?? '未知'}。`
      if (question && text.trim()) {
        turns.push({ id: m.id, messages: [question, { role: 'assistant', content: text }], summary })
      } else if (!text.trim()) {
        turns.push({ id: m.id, messages: [], summary })
      }
      question = undefined
    }
  }
  return { turns, previousResults }
}

// 第④层：当前时间、范围、是否包含 R-18、检索到的记忆、动态情景提示，加上这句话
export function buildTurnTail(
  text: string,
  scope: string | null,
  includeR18: boolean,
  now: Date,
  memories: string[],
  sessionState?: string,
  cues?: TurnTailCues
): PromptMessage[] {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const memo = memories.length ? `\n[软件附注] 记得的偏好：\n${memories.map((m) => `- ${m}`).join('\n')}` : ''
  const session = sessionState ? `\n${sessionState}` : ''
  const situational: string[] = []
  const recent = cues?.recentAssistantTexts?.slice(-2) ?? []
  if (recent.length === 2 && recent.every(hasMiaoOrKaomoji)) {
    situational.push('[情景] 最近两轮刚用过“喵”或类似颜文字，这轮换个更自然的收尾。')
  }
  if (cues?.previousInterrupted) {
    situational.push('[情景] 上一轮在半途被主人打断，直接顺着新指示接上，不道歉，不重复刚才已经试过的同参数查询。')
  }
  if (cues?.addedTags?.length) {
    situational.push(`[图库最新变更] 新增可用标签（类目录已确认）：${cues.addedTags.join('、')}`)
  }
  const cueText = situational.length ? `\n${situational.join('\n')}` : ''
  return [
    { role: 'system', content: `当前时间 ${time}。图库工具范围为${scope ? `「${scope}」` : '全部类目录'}，${includeR18 ? '包含' : '不包含'} R-18。${memo}${session}${cueText}` },
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
