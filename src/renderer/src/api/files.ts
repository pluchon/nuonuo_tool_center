import type { DeleteResultVO, FileOpDoneVO, GalleryQueryDTO } from '@shared/api'
import { unwrap } from './request'

// 删除（先在库里藏起来，过几秒才进系统回收站，期间可以撤销）
export function deleteImages(query: GalleryQueryDTO, imageIds: number[]): Promise<DeleteResultVO> {
  return unwrap(window.api.files.remove(query, imageIds))
}

// 撤销还没执行的删除
export function undoDelete(batchId: number): Promise<void> {
  return unwrap(window.api.files.undoDelete(batchId))
}

// 订阅文件操作执行完的通知
export function onFileOpDone(listener: (result: FileOpDoneVO) => void): () => void {
  return window.api.files.onDone(listener)
}
