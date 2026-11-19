import type { DeleteResultVO, FileOpDoneVO, GalleryQueryDTO, TransferResultVO, TransferRootsVO } from '@shared/api'
import { unwrap } from './request'

// 删除（先在库里藏起来，过几秒才进系统回收站，期间可以撤销）
export function deleteImages(query: GalleryQueryDTO, imageIds: number[]): Promise<DeleteResultVO> {
  return unwrap(window.api.files.remove(query, imageIds))
}

// 撤销还没执行的删除
export function undoDelete(batchId: number): Promise<void> {
  return unwrap(window.api.files.undoDelete(batchId))
}

// 移动 / 复制对话框的两组顶层目录
export function fetchTransferRoots(): Promise<TransferRootsVO> {
  return unwrap(window.api.files.transferRoots())
}

// 移动到一个目录
export function moveImages(query: GalleryQueryDTO, imageIds: number[], target: string): Promise<TransferResultVO> {
  return unwrap(window.api.files.move(query, imageIds, target))
}

// 复制到一个或多个目录
export function copyImages(query: GalleryQueryDTO, imageIds: number[], targets: string[]): Promise<TransferResultVO> {
  return unwrap(window.api.files.copy(query, imageIds, targets))
}

// 撤销刚做的移动或复制
export function undoTransfer(batchId: number): Promise<TransferResultVO> {
  return unwrap(window.api.files.undoTransfer(batchId))
}

// 把一张图复制到剪贴板
export function copyImageToClipboard(fileId: number): Promise<void> {
  return unwrap(window.api.files.copyImage(fileId))
}

// 拖进窗口的文件或文件夹在磁盘上的路径
export function pathOfDropped(file: File): string {
  return window.api.files.pathOf(file)
}

// 订阅文件操作执行完的通知
export function onFileOpDone(listener: (result: FileOpDoneVO) => void): () => void {
  return window.api.files.onDone(listener)
}
