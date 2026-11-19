import type { CreateTagDTO, SaveTagDTO, TagCategoryVO } from '@shared/api'
import { unwrap } from './request'

// 新建标签，返回新标签 id
export function createTag(dto: CreateTagDTO): Promise<number> {
  return unwrap(window.api.tags.create(dto))
}

// 保存标签（改名、分类、别名、合并），返回保存后要选中的标签 id
export function saveTag(dto: SaveTagDTO): Promise<number> {
  return unwrap(window.api.tags.save(dto))
}

// 删除标签，返回去掉这个标签的图片张数
export function deleteTag(id: number): Promise<number> {
  return unwrap(window.api.tags.remove(id))
}

// 新增分类
export function createCategory(): Promise<TagCategoryVO> {
  return unwrap(window.api.tags.createCategory())
}

// 分类改名
export function renameCategory(id: number, name: string): Promise<string> {
  return unwrap(window.api.tags.renameCategory(id, name))
}

// 换分类颜色
export function setCategoryColor(id: number, colorIndex: number): Promise<void> {
  return unwrap(window.api.tags.setCategoryColor(id, colorIndex))
}

// 删除分类
export function removeCategory(id: number): Promise<void> {
  return unwrap(window.api.tags.removeCategory(id))
}
