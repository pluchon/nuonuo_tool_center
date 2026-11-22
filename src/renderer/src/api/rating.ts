import type { RatingProgressVO } from '@shared/api'
import { unwrap } from './request'

// 订阅“本地分级判出了 R-18”（带张数），返回取消订阅的函数
export function onRatingR18(listener: (count: number) => void): () => void {
  return window.api.rating.onR18(listener)
}

// 本地分级的当前进度
export function fetchRatingProgress(): Promise<RatingProgressVO> {
  return unwrap(window.api.rating.progress())
}

// 订阅本地分级的进度
export function onRatingProgress(listener: (p: RatingProgressVO) => void): () => void {
  return window.api.rating.onProgress(listener)
}
