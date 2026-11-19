import type { FolderNodeVO, LibraryOverviewVO, LibraryRootVO } from '@shared/api'
import { unwrap } from './request'

// 侧栏和底栏需要的数据：计数、源目录、顶层类目录、最近扫描时间
export function fetchLibraryOverview(): Promise<LibraryOverviewVO> {
  return unwrap(window.api.library.getOverview())
}

// 把选中的文件夹导入为源目录（导入后主进程自动开始扫描）
export function importSourceRoot(path: string): Promise<LibraryRootVO> {
  return unwrap(window.api.library.addRoot(path))
}

// 源目录找不到时改到新位置（改完自动重新扫描）
export function relocateSourceRoot(id: number, path: string): Promise<LibraryRootVO> {
  return unwrap(window.api.library.relocateRoot(id, path))
}

// 导入对话框的一层文件夹：parent 为空时列盘符
export function fetchFolders(parent: string | null): Promise<FolderNodeVO[]> {
  return unwrap(window.api.library.listFolders(parent))
}
