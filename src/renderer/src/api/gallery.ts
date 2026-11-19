import type { GalleryListVO, GalleryQueryDTO, ImageDetailVO } from '@shared/api'
import { unwrap } from './request'

// 网格数据：主进程按条件过滤、排好序
export function fetchGallery(query: GalleryQueryDTO): Promise<GalleryListVO> {
  return unwrap(window.api.gallery.list(query))
}

// 一张图的详情
export function fetchImageDetail(imageId: number): Promise<ImageDetailVO> {
  return unwrap(window.api.gallery.detail(imageId))
}

// 在资源管理器里打开文件所在的文件夹
export function showFileInFolder(fileId: number): Promise<void> {
  return unwrap(window.api.gallery.showInFolder(fileId))
}

// 缩略图地址（自定义协议，不经 IPC 传图片数据）
export function thumbUrl(hash: string): string {
  return `ltm://thumb/${hash}.webp`
}

// 原图地址（大图用）：按文件 id 取，带上内容哈希，图换了内容就不会用到旧缓存
export function originalUrl(fileId: number, hash: string): string {
  return `ltm://file/${fileId}?h=${hash}`
}

// 用系统默认程序打开文件
export function openFileWithDefault(fileId: number): Promise<void> {
  return unwrap(window.api.gallery.open(fileId))
}
