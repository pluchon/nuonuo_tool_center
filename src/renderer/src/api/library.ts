import type { LibraryOverviewVO, LibraryRootVO } from '@shared/api'
import { unwrap } from './request'

// 侧栏和底栏需要的数据：计数、源目录、顶层类目录
export function fetchLibraryOverview(): Promise<LibraryOverviewVO> {
  return unwrap(window.api.library.getOverview())
}

// 选择文件夹并导入为源目录
export function importSourceRoot(): Promise<LibraryRootVO> {
  return unwrap(window.api.library.addRoot())
}
