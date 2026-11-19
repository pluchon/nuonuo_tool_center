import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ScanFormat } from '@shared/settings'
import { isSkippedDir } from '../../common/pathUtil'
import { formatOfFile } from './formats'

// 遍历到的一个图片文件
export interface WalkedFile {
  // 相对源目录的路径（反斜杠分隔）
  relPath: string
  format: ScanFormat
  size: number
  mtime: Date
}

// 一次遍历的结果：读到的图片文件，以及读不了的子目录和文件（它们下面的记录不能当成“不见了”）
export interface WalkResult {
  files: WalkedFile[]
  unreadableDirs: string[]
  unreadableFiles: string[]
}

// 根目录本身读不了（找不到、没接上、没权限）
export class RootUnavailableError extends Error {
  constructor(readonly rootPath: string, cause: unknown) {
    super(`目录读不了：${rootPath}`, { cause })
    this.name = 'RootUnavailableError'
  }
}

// 递归遍历一个目录，收集图片文件；跳过隐藏和系统目录，不跟随符号链接。shouldStop 返回 true 时提前结束
export async function walkRoot(rootPath: string, shouldStop: () => boolean): Promise<WalkResult> {
  const result: WalkResult = { files: [], unreadableDirs: [], unreadableFiles: [] }
  try {
    const info = await stat(rootPath)
    if (!info.isDirectory()) {
      throw new Error('不是文件夹')
    }
  } catch (err) {
    throw new RootUnavailableError(rootPath, err)
  }
  const pending: string[] = [rootPath]
  while (pending.length > 0 && !shouldStop()) {
    const dir = pending.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (dir === rootPath) {
        throw new RootUnavailableError(rootPath, err)
      }
      result.unreadableDirs.push(relative(rootPath, dir))
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) {
          pending.push(full)
        }
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      const format = formatOfFile(entry.name)
      if (!format) {
        continue
      }
      const relPath = relative(rootPath, full)
      try {
        const info = await stat(full)
        result.files.push({ relPath, format, size: info.size, mtime: info.mtime })
      } catch {
        result.unreadableFiles.push(relPath)
      }
    }
  }
  return result
}
