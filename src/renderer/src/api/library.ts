import type { LibraryRootVO } from '@shared/api'
import { unwrap } from './request'

// 列出已导入的图库目录
export function fetchLibraryRoots(): Promise<LibraryRootVO[]> {
  return unwrap(window.api.library.listRoots())
}

// 弹出目录选择框并导入所选目录
export function importLibraryRoot(): Promise<LibraryRootVO> {
  return unwrap(window.api.library.addRoot())
}
