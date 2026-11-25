import type {
  AiAttachment,
  AiContextUsage,
  AiImageReference,
  AiReplyCacheUsage,
  DirKeyDTO
} from '@shared/api'
import { BizError } from '../../../common/bizError'
import type { AiConversationEntity } from '../../../repositories/aiConversationRepository'
import type { StoredAttachment } from '../assistantAttachment'
import type { CategoryReply } from '../categoryProposalService'
import type { CompactionProgress } from '../conversationCompaction'
import type { CondLabel, DictTag } from '../localRouter'
import type { MatchEvidence } from '../searchFeedback'
import type { SearchOutcome } from '../search/hybridSearch'

export type CurrentConversation = AiConversationEntity & { lastAt: Date }

// 旧版本分别使用过 image 和 attachment，读取时统一为附件列表。
export interface UserContent {
  references?: AiImageReference[]
  preparedProposalId?: number
  text: string
  scope: DirKeyDTO | null
  includeR18: boolean
  attachments?: StoredAttachment[]
  attachment?: AiAttachment
  image?: string
}

// 回复正文与结果卡片分开保存，历史回放也按当前分级和复核状态读取卡片。
export interface AssistantContent {
  compactSummary?: string
  nextPrediction?: string
  evidence?: MatchEvidence
  incomplete?: string
  categoryProposalId?: number
  proposalNote?: true
  cardCaption?: boolean
  text: string
  how: string | null
  imageIds: number[]
  contextUsage?: AiContextUsage
  cacheUsage?: AiReplyCacheUsage
  // 读取单图详情或词表的正文可能含随后改为 R-18 的信息，追问时重新查询。
  readLibraryMetadata?: boolean
  focusReferences?: AiImageReference[]
  focusSignature?: string
  // 这次回答带上的记忆（赞、踩时调整它们的可信度）
  memoryIds?: number[]
}

export function attachmentsOf(content: UserContent): StoredAttachment[] {
  if (content.attachments) return content.attachments
  if (content.attachment) return [content.attachment]
  return content.image ? [{ kind: 'image', name: '', mimeType: 'image/jpeg', dataUrl: content.image }] : []
}

// Markdown 正文属于用户消息；历史轮次同样保留正文，以支持追问附件。
export function userText(content: UserContent): string {
  const file = attachmentsOf(content).find((a) => a.kind === 'markdown')
  if (file) {
    return [content.text, `附件「${file.name}」\n${file.text}`].filter(Boolean).join('\n\n')
  }
  return content.text || (content.references?.length ? '（引用图库图片）' : '（发了一张图，让诺诺按图找相似的）')
}

export function localReplyText(found: number): string {
  return found ? '' : '没找到符合条件的图片。'
}

// 旧版本可能把模型复述的内部注记当作回答保存。只信任本轮实际保存的结果编号。
export function replyText(content: AssistantContent): string {
  if (/[（(]给用户看了\s*\d+\s*张图/.test(content.text)) {
    return content.imageIds?.length ? localReplyText(content.imageIds.length) : '这条旧回复没有保存图片结果。'
  }
  if ('llm' in content && content.how) return localReplyText(content.imageIds?.length ?? 0)
  return content.text
}

// 路径或权限问题可以在聊天中改正，无需重试百炼请求。
export function directoryFeedback(error: unknown): { text: string } {
  if (error instanceof BizError) return { text: error.message }
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    return { text: '无法读取类目录，请检查目录位置和访问权限。' }
  }
  throw error
}

export interface PreviousSearchState {
  ids: number[]
  includeR18: boolean
  scope: DirKeyDTO | null
  evidence?: MatchEvidence
  incomplete?: string
}

// 工具执行的只读环境
export interface ToolEnv {
  userText: string
  query: string
  hasInputContext: boolean
  compactionProgress?: CompactionProgress
  tags: Array<DictTag & { general: boolean }>
  dirs: Array<{ rootId: number; prefix: string }> | undefined
  selectedCategory?: string
  includeR18: boolean
  userMessageId: number
  candidateIds?: number[]
  modelReferences?: Array<Pick<AiImageReference, 'imageId' | 'position'>>
  previousProposal?: { id: number; messageId: number }
  previousResults?: PreviousSearchState
  referenceNotes?: string
  preferenceIds?: number[]
  readReferences: () => Promise<Array<{ imageId: number; name: string; tags: string[] }>>
}

// 强类型、无副作用的工具输出，由 Harness 主循环统一归约到 HarnessState
export type ToolOutcome =
  | {
      type: 'search'
      outcome: SearchOutcome
      conds: CondLabel[]
      caption?: string
      needsDetails: boolean
      cacheablePlan?: Record<string, unknown>
    }
  | { type: 'awaiting_contrast'; args: Record<string, unknown> }
  | { type: 'proposal'; proposal: CategoryReply }
  | { type: 'discussion'; text: string; suggestion?: string }
  | {
      type: 'exclusion'
      imageIds: number[]
      text: string
      how: string
      evidence?: MatchEvidence
      incomplete?: string
    }
  | { type: 'metadata' }
  | { type: 'none' }

export interface HarnessState {
  lastSearch: { outcome: SearchOutcome; conds: CondLabel[]; caption?: string } | null
  needsDetails: boolean
  otherToolUsed: boolean
  readLibraryMetadata: boolean
  cacheablePlan?: Record<string, unknown>
  awaitingContrast?: Record<string, unknown>
  discussionReply?: { text: string; suggestion?: string }
  directoryProposal?: CategoryReply
  exclusionReply?: {
    imageIds: number[]
    text: string
    how: string
    evidence?: MatchEvidence
    incomplete?: string
  }
  contextUsage?: AiContextUsage
  memoryIds?: number[]
}

export function createInitialHarnessState(hasInputContext: boolean, hasReferenceNote: boolean): HarnessState {
  return {
    lastSearch: null,
    needsDetails: hasInputContext,
    otherToolUsed: false,
    readLibraryMetadata: hasReferenceNote
  }
}

export function reduceToolOutcome(state: HarnessState, toolName: string, outcome?: ToolOutcome): HarnessState {
  const next: HarnessState = {
    ...state,
    otherToolUsed: state.otherToolUsed || toolName !== 'search_images'
  }
  if (!outcome || outcome.type === 'none') {
    return next
  }
  if (outcome.type === 'metadata') {
    return { ...next, readLibraryMetadata: true }
  }
  if (outcome.type === 'awaiting_contrast') {
    return { ...next, awaitingContrast: outcome.args }
  }
  if (outcome.type === 'search') {
    return {
      ...next,
      otherToolUsed: next.otherToolUsed || state.lastSearch !== null,
      awaitingContrast: undefined,
      lastSearch: { outcome: outcome.outcome, conds: outcome.conds, caption: outcome.caption },
      needsDetails: state.needsDetails || outcome.needsDetails,
      cacheablePlan: outcome.cacheablePlan ?? state.cacheablePlan
    }
  }
  if (outcome.type === 'proposal') {
    return { ...next, directoryProposal: outcome.proposal }
  }
  if (outcome.type === 'discussion') {
    return { ...next, discussionReply: { text: outcome.text, suggestion: outcome.suggestion } }
  }
  if (outcome.type === 'exclusion') {
    return {
      ...next,
      readLibraryMetadata: true,
      exclusionReply: {
        imageIds: outcome.imageIds,
        text: outcome.text,
        how: outcome.how,
        evidence: outcome.evidence,
        incomplete: outcome.incomplete
      }
    }
  }
  return next
}
