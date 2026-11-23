import type { AiAskDTO, AiAskResultVO, AiConversationVO, AiMessageVO, AiRecalledDraft, AiStatusVO } from '@shared/api'
import { unwrap } from './request'

// 诺诺能不能用（有没有配置云端凭证）
export function fetchAiStatus(): Promise<AiStatusVO> {
  return unwrap(window.api.ai.status())
}

// 新对话的四个示例问题
export function fetchIdeas(): Promise<string[]> {
  return unwrap(window.api.ai.ideas())
}

// 对话记录
export function fetchConversations(): Promise<AiConversationVO[]> {
  return unwrap(window.api.ai.conversations())
}

// 一段对话的消息
export function fetchMessages(conversationId: number): Promise<AiMessageVO[]> {
  return unwrap(window.api.ai.messages(conversationId))
}

// 说一句话（先存下，回复另外取）
export function askNono(dto: AiAskDTO): Promise<AiAskResultVO> {
  return unwrap(window.api.ai.ask(dto))
}

// 取这段对话最后一句话的回复
export function fetchAnswer(conversationId: number): Promise<AiMessageVO> {
  return unwrap(window.api.ai.answer(conversationId))
}

export function editMessage(id: number, messageId: number, text: string): Promise<AiMessageVO> {
  return unwrap(window.api.ai.editMessage(id, messageId, text))
}

export function recallMessage(id: number, messageId: number): Promise<AiRecalledDraft> {
  return unwrap(window.api.ai.recallMessage(id, messageId))
}

export function fetchRecalledDraft(id: number): Promise<AiRecalledDraft | null> {
  return unwrap(window.api.ai.recalledDraft(id))
}

// 重命名对话
export function renameConversation(id: number, title: string): Promise<AiConversationVO> {
  return unwrap(window.api.ai.rename(id, title))
}

// 置顶 / 取消置顶
export function pinConversation(id: number, pinned: boolean): Promise<void> {
  return unwrap(window.api.ai.pin(id, pinned))
}

// 删除对话
export function removeConversation(id: number): Promise<void> {
  return unwrap(window.api.ai.remove(id))
}

// 撤销删除对话
export function undoRemoveConversation(id: number): Promise<void> {
  return unwrap(window.api.ai.undoRemove(id))
}

// 赞、踩或取消
export function voteMessage(messageId: number, vote: 'UP' | 'DOWN' | null): Promise<void> {
  return unwrap(window.api.ai.vote(messageId, vote))
}
