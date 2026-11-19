import type { DirNodeVO, FolderRefDTO } from '@shared/api'
import { unwrap } from './request'

// 侧栏目录树展开一层
export function fetchDirChildren(ref: FolderRefDTO): Promise<DirNodeVO[]> {
  return unwrap(window.api.folders.children(ref))
}

// 新建目录（名字为空用默认名），返回新目录相对所属根的路径
export function createFolder(parent: FolderRefDTO, name: string | null): Promise<string> {
  return unwrap(window.api.folders.create(parent, name))
}

// 类目录改名，返回新路径
export function renameFolder(ref: FolderRefDTO, name: string): Promise<string> {
  return unwrap(window.api.folders.rename(ref, name))
}

// 删除类目录（进系统回收站）
export function deleteFolder(ref: FolderRefDTO): Promise<number> {
  return unwrap(window.api.folders.remove(ref))
}

// 在资源管理器里打开目录
export function openFolder(ref: FolderRefDTO): Promise<void> {
  return unwrap(window.api.folders.open(ref))
}

// 从图库移除源目录（磁盘文件不动）
export function removeSource(id: number): Promise<void> {
  return unwrap(window.api.folders.removeSource(id))
}
