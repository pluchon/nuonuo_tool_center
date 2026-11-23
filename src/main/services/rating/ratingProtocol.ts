// 主进程和分级工作进程之间的消息
import type { WdRating } from './wdTagger'

export const WD_GENERAL_THRESHOLD = 0.35

// 请求：给一张图（缩略图文件）分级
export interface RatingRequest {
  id: number
  file: string
  modelDir: string
  // 这次用几个 CPU 线程（和上次不同时工作进程重新加载模型）
  threads: number
}

// 回复：四个分级的分数，或失败原因
export type RatingResponse =
  | { id: number; ok: true; scores: Record<WdRating, number>; tags: string[] }
  | { id: number; ok: false; error: string }
