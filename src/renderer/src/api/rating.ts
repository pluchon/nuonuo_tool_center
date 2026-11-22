// 订阅“本地分级判出了 R-18”（带张数），返回取消订阅的函数
export function onRatingR18(listener: (count: number) => void): () => void {
  return window.api.rating.onR18(listener)
}
