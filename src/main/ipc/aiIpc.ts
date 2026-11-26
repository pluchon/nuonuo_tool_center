import { IpcChannel, IpcEvent, organizeUsesLookQueue, type AiAskDTO, type AiPredictionDTO, type AiStreamEvent } from '@shared/api'
import { BizError } from '../common/bizError'
import type { DataPaths } from '../config/paths'
import { attachmentOriginal } from '../repositories/aiConversationRepository'
import { referencePreviews } from '../repositories/aiReferenceRepository'
import { changePreference, getAiPolicy, resetOrganizeRules, setEmbeddingLimit } from '../services/ai/aiPolicy'
import {
  abortAnswer,
  answer,
  ask,
  compactConversation,
  deleteConversation,
  editMessage,
  getAiStatus,
  getRecalledDraft,
  listConversations,
  listMessages,
  pinConversation,
  recallMessage,
  renameConversation,
  suggestIdeas,
  undoDeleteConversation,
  voteMessage
} from '../services/ai/assistantService'
import { decideCategoryProposal, getCategoryProposal } from '../services/ai/categoryProposalService'
import { scheduleEmbedding } from '../services/ai/embeddingService'
import { cancelAllLooks, getLookState, getSuggestionRefreshStatus, lookNow, refreshSuggestion, retryLook } from '../services/ai/lookService'
import { predictNext } from '../services/ai/nextPrediction'
import { approveOrganize, cancelOrganize, estimateOrganize, getOrganizeState, startOrganize } from '../services/ai/organizeService'
import { estimateReorganize, resetOrganizedToSource, startReorganizeRelook } from '../services/ai/reorganizeService'
import { acceptAllSuggestions, assistPrompt, decideMany, decideSuggestion, importAssist, listSuggestions } from '../services/ai/suggestionService'
import { getRatingProgress } from '../services/rating/ratingService'
import { handle } from './handle'
import { refreshImageIndex, requireDatabase } from './shared'

// 注册 AI 助手、看图队列、建议、一键整理、分级进度、分类提案与外部协助 IPC 处理器
export function registerAiIpc(paths: DataPaths): void {
  handle(IpcChannel.aiStatus, async () => getAiStatus())
  handle(IpcChannel.aiPredict, async (_event, dto: AiPredictionDTO) => {
    requireDatabase()
    return predictNext(dto)
  })
  handle(IpcChannel.aiIdeas, async () => {
    requireDatabase()
    return suggestIdeas()
  })
  handle(IpcChannel.aiConversations, async () => {
    requireDatabase()
    return listConversations()
  })
  handle(IpcChannel.aiMessages, async (_event, conversationId: number) => {
    requireDatabase()
    return listMessages(conversationId)
  })
  handle(IpcChannel.aiAttachmentOriginal, async (_event, messageId: number) => {
    requireDatabase()
    return attachmentOriginal(messageId)
  })
  handle(IpcChannel.aiAsk, async (_event, dto: AiAskDTO) => {
    requireDatabase()
    return ask(dto)
  })
  handle(IpcChannel.categoryProposal, async (_event, id: number, messageId: number) => {
    requireDatabase()
    return getCategoryProposal(id, messageId)
  })
  handle(IpcChannel.categoryProposalDecide, async (_event, id: number, messageId: number, apply: boolean) => {
    requireDatabase()
    return decideCategoryProposal(id, messageId, apply)
  })
  handle(IpcChannel.aiCompact, async (_event, id: number) => {
    requireDatabase()
    return compactConversation(id)
  })
  handle(IpcChannel.aiAnswer, async (event, conversationId: number) => {
    requireDatabase()
    const emitStream = (ev: Omit<AiStreamEvent, 'conversationId'>): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcEvent.aiStream, { conversationId, ...ev } satisfies AiStreamEvent)
      }
    }
    try {
      const reply = await answer(
        conversationId,
        active => {
          if (!event.sender.isDestroyed()) event.sender.send(IpcEvent.aiCompaction, conversationId, active)
        },
        emitStream
      )
      emitStream({ kind: reply.interrupted ? 'aborted' : 'done' })
      return reply
    } catch (err) {
      emitStream({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      throw err
    } finally { scheduleEmbedding() }
  })
  handle(IpcChannel.aiAbort, async (_event, conversationId: number) => {
    requireDatabase()
    return abortAnswer(conversationId)
  })
  handle(IpcChannel.aiPolicy, async () => { requireDatabase(); return getAiPolicy() })
  handle(IpcChannel.aiUsageStats, async () => {
    requireDatabase()
    const { getAiUsageStats } = await import('../services/ai/usageStatsService')
    return getAiUsageStats()
  })
  handle(IpcChannel.aiReferencePreviews, async (_event, ids: number[]) => { requireDatabase(); return referencePreviews(ids) })
  handle(IpcChannel.aiResetRules, async () => { requireDatabase(); await resetOrganizeRules() })
  handle(IpcChannel.aiEmbeddingLimit, async (_event, limit: number) => {
    requireDatabase()
    await setEmbeddingLimit(limit)
    scheduleEmbedding()
  })
  handle(IpcChannel.aiPreference, async (_event, id: number, content: string | null) => {
    requireDatabase()
    await changePreference(id, content)
  })
  handle(IpcChannel.aiEditMessage, async (_event, id: number, messageId: number, text: string) => {
    requireDatabase()
    return editMessage(id, messageId, text)
  })
  handle(IpcChannel.aiRecallMessage, async (_event, id: number, messageId: number) => {
    requireDatabase()
    return recallMessage(id, messageId)
  })
  handle(IpcChannel.aiRecalledDraft, async (_event, id: number) => {
    requireDatabase()
    return getRecalledDraft(id)
  })
  handle(IpcChannel.aiRename, async (_event, id: number, title: string) => {
    requireDatabase()
    return renameConversation(id, title)
  })
  handle(IpcChannel.aiPin, async (_event, id: number, pinned: boolean) => {
    requireDatabase()
    await pinConversation(id, pinned)
  })
  handle(IpcChannel.aiDelete, async (_event, id: number) => {
    requireDatabase()
    await deleteConversation(id)
  })
  handle(IpcChannel.aiUndoDelete, async (_event, id: number) => {
    requireDatabase()
    await undoDeleteConversation(id)
  })
  handle(IpcChannel.aiVote, async (_event, messageId: number, vote: 'UP' | 'DOWN' | null) => {
    requireDatabase()
    await voteMessage(messageId, vote)
  })
  handle(IpcChannel.lookState, async () => {
    requireDatabase()
    return getLookState()
  })
  handle(IpcChannel.lookRetry, async (_event, jobId: number) => {
    requireDatabase()
    if (!Number.isInteger(jobId)) {
      throw new BizError('BAD_REQUEST', '任务 id 不对')
    }
    await retryLook(jobId)
  })
  handle(IpcChannel.lookNow, async (_event, imageId: number) => {
    requireDatabase()
    if (!Number.isInteger(imageId)) {
      throw new BizError('BAD_REQUEST', '图片 id 不对')
    }
    await lookNow(imageId)
  })
  handle(IpcChannel.lookCancelAll, async () => {
    requireDatabase()
    if (organizeUsesLookQueue(getOrganizeState().phase)) {
      throw new BizError('CONFLICT', '请从一键整理停止当前整理')
    }
    return cancelAllLooks()
  })
  handle(IpcChannel.lookRefreshSuggestion, async (_event, imageId: number) => {
    requireDatabase()
    if (!Number.isInteger(imageId) || imageId <= 0) {
      throw new BizError('BAD_REQUEST', '图片 id 不对')
    }
    return refreshSuggestion(imageId)
  })
  handle(IpcChannel.lookRefreshStatus, async (_event, imageId: number) => {
    requireDatabase()
    if (!Number.isInteger(imageId) || imageId <= 0) {
      throw new BizError('BAD_REQUEST', '图片 id 不对')
    }
    return getSuggestionRefreshStatus(imageId)
  })
  handle(IpcChannel.suggestionList, async (_event, imageId: number) => {
    requireDatabase()
    return listSuggestions(imageId)
  })
  handle(IpcChannel.suggestionDecide, async (_event, imageId: number, key: string, accept: boolean, value?: unknown) => {
    requireDatabase()
    if (typeof key !== 'string' || typeof accept !== 'boolean' || (value !== undefined && typeof value !== 'string')) {
      throw new BizError('BAD_REQUEST', '参数不对')
    }
    return decideSuggestion(imageId, key, accept, value).then(refreshImageIndex)
  })
  handle(IpcChannel.suggestionAcceptAll, async (_event, imageId: number, overrides?: unknown) => {
    requireDatabase()
    let validOverrides: Record<string, string> | undefined
    if (overrides !== undefined) {
      const proto = typeof overrides === 'object' && overrides !== null ? Object.getPrototypeOf(overrides) : null
      if (
        typeof overrides !== 'object' ||
        overrides === null ||
        Array.isArray(overrides) ||
        (proto !== Object.prototype && proto !== null) ||
        Object.values(overrides).some((v) => typeof v !== 'string')
      ) {
        throw new BizError('BAD_REQUEST', '参数不对')
      }
      validOverrides = overrides as Record<string, string>
    }
    return acceptAllSuggestions(imageId, validOverrides).then(refreshImageIndex)
  })
  handle(IpcChannel.suggestionDecideMany, async (_event, imageIds: unknown, accept: unknown) => {
    requireDatabase()
    if (typeof accept !== 'boolean') {
      throw new BizError('BAD_REQUEST', '参数不对')
    }
    return decideMany(imageIds, accept).then(refreshImageIndex)
  })
  handle(IpcChannel.ratingProgress, async () => getRatingProgress())
  handle(IpcChannel.organizeState, async () => {
    requireDatabase()
    return getOrganizeState()
  })
  const estimates = new Map<number, AbortController>()
  handle(IpcChannel.organizeEstimate, async ({ sender }) => {
    requireDatabase()
    const id = sender.id
    estimates.get(id)?.abort()
    const controller = new AbortController()
    estimates.set(id, controller)
    const stop = () => controller.abort(new BizError('CONFLICT', '已关闭整理估算'))
    sender.once('destroyed', stop)
    try {
      return await estimateOrganize(controller.signal)
    } finally {
      sender.removeListener('destroyed', stop)
      if (estimates.get(id) === controller) estimates.delete(id)
    }
  })
  handle(IpcChannel.organizeDismissEstimate, async ({ sender }) => {
    estimates.get(sender.id)?.abort(new BizError('CONFLICT', '已关闭整理估算'))
  })
  handle(IpcChannel.organizeStart, async () => {
    requireDatabase()
    return startOrganize()
  })
  handle(IpcChannel.organizeApprove, async (_event, plan: unknown) => {
    requireDatabase()
    return approveOrganize(plan)
  })
  handle(IpcChannel.organizeCancel, async () => {
    requireDatabase()
    return cancelOrganize()
  })
  const reorgEstimates = new Map<number, AbortController>()
  handle(IpcChannel.reorganizeEstimate, async ({ sender }) => {
    requireDatabase()
    const id = sender.id
    reorgEstimates.get(id)?.abort()
    const controller = new AbortController()
    reorgEstimates.set(id, controller)
    const stop = () => controller.abort(new BizError('CONFLICT', '已关闭重新整理估算'))
    sender.once('destroyed', stop)
    try {
      return await estimateReorganize(controller.signal)
    } finally {
      sender.removeListener('destroyed', stop)
      if (reorgEstimates.get(id) === controller) reorgEstimates.delete(id)
    }
  })
  handle(IpcChannel.reorganizeDismissEstimate, async ({ sender }) => {
    reorgEstimates.get(sender.id)?.abort(new BizError('CONFLICT', '已关闭重新整理估算'))
  })
  handle(IpcChannel.reorganizeResetToSource, async () => {
    requireDatabase()
    return resetOrganizedToSource().then(refreshImageIndex)
  })
  handle(IpcChannel.reorganizeRelook, async () => {
    requireDatabase()
    return startReorganizeRelook()
  })
  handle(IpcChannel.assistPrompt, async (_event, imageId: number) => {
    requireDatabase()
    return assistPrompt(imageId)
  })
  handle(IpcChannel.assistImport, async (_event, imageId: number, raw: unknown) => {
    requireDatabase()
    return importAssist(imageId, raw, paths.thumbs)
  })
}
