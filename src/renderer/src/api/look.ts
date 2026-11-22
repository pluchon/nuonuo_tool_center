import type { AiSuggestionVO, LookStateVO, SuggestionBatchVO } from '@shared/api'
import { unwrap } from './request'

// 看图队列的当前状态
export function fetchLookState(): Promise<LookStateVO> {
  return unwrap(window.api.look.state())
}

// 重试一张出错的
export function retryLook(jobId: number): Promise<void> {
  return unwrap(window.api.look.retry(jobId))
}

// 让一张图现在就看
export function lookNow(imageId: number): Promise<void> {
  return unwrap(window.api.look.now(imageId))
}

// 全部取消
export function cancelAllLooks(): Promise<number> {
  return unwrap(window.api.look.cancelAll())
}

// 订阅看图队列的变化
export function onLookState(listener: (state: LookStateVO) => void): () => void {
  return window.api.look.onState(listener)
}

// 订阅“有新的 AI 建议”
export function onSuggested(listener: () => void): () => void {
  return window.api.look.onSuggested(listener)
}

// 一张图待确认的建议
export function fetchSuggestions(imageId: number): Promise<AiSuggestionVO[]> {
  return unwrap(window.api.suggestion.list(imageId))
}

// 采用或不要一项，返回剩下的
export function decideSuggestion(imageId: number, key: string, accept: boolean): Promise<AiSuggestionVO[]> {
  return unwrap(window.api.suggestion.decide(imageId, key, accept))
}

// 全部采用
export function acceptAllSuggestions(imageId: number): Promise<AiSuggestionVO[]> {
  return unwrap(window.api.suggestion.acceptAll(imageId))
}

// 多张图的建议一起采用或不要
export function decideManySuggestions(imageIds: number[], accept: boolean): Promise<SuggestionBatchVO> {
  return unwrap(window.api.suggestion.decideMany(imageIds, accept))
}

// 复制给其他 AI 的提示词
export function fetchAssistPrompt(imageId: number): Promise<string> {
  return unwrap(window.api.suggestion.assistPrompt(imageId))
}

// 把其他 AI 回的结果交给诺诺整理，返回整理出几项
export function importAssist(imageId: number, raw: unknown): Promise<number> {
  return unwrap(window.api.suggestion.assistImport(imageId, raw))
}
