import { isAbsolute, relative } from 'node:path'

// 不当作用户文件夹的系统目录（小写比较）
const SKIPPED_DIRS = new Set(['$recycle.bin', 'system volume information'])

// 判断 child 是否位于 parent 之内（含相等），按 Windows 不区分大小写比较
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent.toLowerCase(), child.toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// 是否跳过这个文件夹：隐藏文件夹（点开头）和回收站等系统目录
export function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name.toLowerCase())
}

// 相对路径统一成小写作为比较键（Windows 文件名不区分大小写）
export function pathKey(relPath: string): string {
  return relPath.toLowerCase()
}
