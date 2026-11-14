import { stat } from 'node:fs/promises'
import { basename, join, relative, resolve, isAbsolute } from 'node:path'
import type { LibraryRootVO } from '@shared/api'
import { BizError } from '../common/bizError'
import { toLibraryRootVO } from '../converter/libraryConverter'
import { findActiveRoots, insertRoot } from '../repositories/libraryRootRepository'

// 每个图库目录下的回收站子目录名，扫描时跳过
export const TRASH_DIR_NAME = '.ltm-trash'

// 规范化目录路径：绝对化并去掉末尾分隔符
function normalizeDir(dir: string): string {
  return resolve(dir)
}

// 判断 child 是否位于 parent 之内（含相等），按 Windows 不区分大小写比较
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent.toLowerCase(), child.toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// 列出已导入的图库目录
export async function listRoots(): Promise<LibraryRootVO[]> {
  const roots = await findActiveRoots()
  return roots.map(toLibraryRootVO)
}

// 导入一个图库目录：必须是存在的目录，且不能与已导入目录重复或互相嵌套
export async function addRoot(rawPath: string): Promise<LibraryRootVO> {
  const path = normalizeDir(rawPath)
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) {
    throw new BizError('BAD_REQUEST', `目录不存在：${path}`)
  }
  const existing = await findActiveRoots()
  const overlap = existing.find((r) => isWithin(r.path, path) || isWithin(path, r.path))
  if (overlap) {
    throw new BizError('CONFLICT', `与已导入的目录重叠：${overlap.path}`)
  }
  const created = await insertRoot({
    name: basename(path) || path,
    path,
    trashDir: join(path, TRASH_DIR_NAME)
  })
  return toLibraryRootVO(created)
}
