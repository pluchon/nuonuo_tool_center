import type { AddTagDTO, AddTagResultVO, DirCountVO, ImageTagVO, TagCatalogVO } from '@shared/api'
import { unwrap } from './request'

// 全部分类和标签
export function fetchTagCatalog(): Promise<TagCatalogVO> {
  return unwrap(window.api.edit.tagCatalog())
}

// 改名字（null 或空串表示用回文件名）
export function renameImage(imageId: number, name: string | null): Promise<string | null> {
  return unwrap(window.api.edit.rename(imageId, name))
}

// 批量标记 / 取消 R-18
export function setImagesR18(imageIds: number[], value: boolean): Promise<number> {
  return unwrap(window.api.edit.setR18(imageIds, value))
}

// 给图加标签
export function addImageTag(dto: AddTagDTO): Promise<AddTagResultVO> {
  return unwrap(window.api.edit.addTag(dto))
}

// 从图上移除标签
export function removeImageTag(imageIds: number[], tagId: number): Promise<number> {
  return unwrap(window.api.edit.removeTag(imageIds, tagId))
}

// 多选时的共同标签
export function fetchCommonTags(imageIds: number[]): Promise<ImageTagVO[]> {
  return unwrap(window.api.edit.commonTags(imageIds))
}

// “还没打标签”的目录筛选项
export function fetchUntaggedDirs(): Promise<DirCountVO[]> {
  return unwrap(window.api.gallery.untaggedDirs())
}
