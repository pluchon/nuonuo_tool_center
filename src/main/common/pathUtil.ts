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

// Windows 文件名里不能出现的字符
const BAD_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
// Windows 保留的设备名
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

// 一个文件夹名合不合法：非空、不含非法字符、不是 . 或 ..、不以空格或点结尾、不是设备名
export function isValidDirName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !BAD_NAME_CHARS.test(name) &&
    !/[ .]$/.test(name) &&
    !RESERVED_NAMES.test(name)
  )
}

// 规整相对文件夹路径（反斜杠分隔）：空串表示根目录本身；有不合法的段返回 null（防止 .. 跳出根目录）
export function normalizeRelDir(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') {
    return ''
  }
  if (typeof raw !== 'string') {
    return null
  }
  const parts = raw.split('\\')
  return parts.every(isValidDirName) ? parts.join('\\') : null
}

// 相对路径统一成小写作为比较键（Windows 文件名不区分大小写）
export function pathKey(relPath: string): string {
  return relPath.toLowerCase()
}
