import { lstat, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BizError } from '../../common/bizError'
import { isSkippedDir, normalizeRelDir } from '../../common/pathUtil'

export function categoryRel(raw: string): string {
  const path = normalizeRelDir(raw.replaceAll('/', '\\'))
  if (!path || path.split('\\').some((name) => isSkippedDir(name) || name.length > 255)) {
    throw new BizError('BAD_REQUEST', '请填写类目录内的相对路径')
  }
  return path
}

// 逐层检查目录。Windows 的目录联接也会改变实际目标，不能只比较路径字符串。
export async function categoryDirectory(home: string, rel: string): Promise<{ abs: string; identity: string } | null> {
  let abs = home
  const parts = rel ? categoryRel(rel).split('\\') : []
  let identity = ''
  for (const part of ['', ...parts]) {
    if (part) abs = join(abs, part)
    const info = await lstat(abs, { bigint: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isDirectory()) throw new BizError('CONFLICT', '路径包含文件或目录链接')
    identity = [info.dev, info.ino, info.birthtimeNs].join(':')
  }
  return { abs, identity }
}

// 相同标签优先复用已有目录。重名时先取层数较少的目录，再按名称排序。
export async function readCategoryTree(home: string, scope: string | null): Promise<string[]> {
  if (!await categoryDirectory(home, scope ?? '')) return []
  const queue = [scope ?? '']
  for (let i = 0; i < queue.length; i++) {
    const rel = queue[i]
    if (!await categoryDirectory(home, rel)) continue
    const entries = await readdir(join(home, rel), { withFileTypes: true })
    const children = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !isSkippedDir(e.name))
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      queue.push(join(rel, entry.name))
    }
  }
  return queue.filter(Boolean)
}

// 建议列表及详情共用一次目录枚举。目录操作立即失效，外部变动最多保留三十秒。
let cached: { home: string; expires: number; paths: Promise<string[]> } | null = null
export function invalidateCategoryTree(): void { cached = null }
export async function cachedCategoryTree(home: string, refresh: boolean): Promise<string[]> {
  if (!refresh && cached?.home === home && cached.expires > Date.now()) return cached.paths
  const current = { home, expires: Date.now() + 30_000, paths: readCategoryTree(home, null) }
  cached = current
  try { return await current.paths } catch (error) {
    if (cached === current) cached = null
    throw error
  }
}

// 完整路径优先；旧建议仅存文件夹名时，按先浅后深的实际目录顺序匹配。
export function categoryPathIndex(paths: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const path of paths) result.set(path.toLowerCase(), path)
  for (const path of paths) {
    const key = basename(path).toLowerCase()
    if (!result.has(key)) result.set(key, path)
  }
  return result
}
