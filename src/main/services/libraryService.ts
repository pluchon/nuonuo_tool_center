import { readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { CategoryDirVO, LibraryOverviewVO, LibraryRootVO } from '@shared/api'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { effectiveCategoryHome } from '../config/paths'
import { toLibraryRootVO, toSidebarCountsVO, toSourceRootVO } from '../converter/libraryConverter'
import {
  countImagesByRoot,
  countImagesByTopFolder,
  countOverview
} from '../repositories/libraryOverviewRepository'
import { findActiveRoots, findActiveRootsByKind, insertRoot } from '../repositories/libraryRootRepository'
import { getSettings } from './settingsService'

const log = getLogger('library')

// “最近导入”统计的天数
const RECENT_DAYS = 30

// 不当作用户文件夹的系统目录
const SKIPPED_DIRS = new Set(['$recycle.bin', 'system volume information'])

// 判断 child 是否位于 parent 之内（含相等），按 Windows 不区分大小写比较
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent.toLowerCase(), child.toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// 列出某个目录下的子文件夹名（跳过隐藏和系统目录）；目录不存在时返回 null，其它读取错误照常抛出
async function childDirs(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name.toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

// 某个目录有没有子文件夹；读不了（比如移动硬盘没接）按没有处理，只记一条日志，不影响侧栏显示
async function hasChildDirs(dir: string): Promise<boolean> {
  try {
    return ((await childDirs(dir)) ?? []).length > 0
  } catch (err) {
    log.warn(`读取子文件夹失败：${dir}`, err)
    return false
  }
}

// 当前生效的类目录位置
async function categoryHomeOf(override: string | null): Promise<string> {
  const { categoryHome } = await getSettings()
  return effectiveCategoryHome(override, categoryHome)
}

// 顶层类目录：类目录位置下的文件夹；位置还不存在时就是还没有类目录
async function listCategoryDirs(home: string): Promise<CategoryDirVO[]> {
  let names: string[] | null
  try {
    names = await childDirs(home)
  } catch (err) {
    log.error(`读取类目录位置失败：${home}`, err)
    throw new BizError('DEPENDENCY_FAILED', `类目录所在的文件夹读不了：${home}`)
  }
  if (!names) {
    return []
  }
  const [catRoot] = await findActiveRootsByKind('CATEGORY')
  const counts = catRoot ? await countImagesByTopFolder(catRoot.id) : new Map<string, number>()
  return Promise.all(
    names.map(async (name) => ({
      name,
      count: counts.get(name.toLowerCase()) ?? 0,
      hasChildren: await hasChildDirs(resolve(home, name))
    }))
  )
}

// 侧栏和底栏需要的全部数据：计数、源目录、顶层类目录
export async function getOverview(categoryHomeOverride: string | null): Promise<LibraryOverviewVO> {
  const [counts, byRoot, sources, home] = await Promise.all([
    countOverview(RECENT_DAYS),
    countImagesByRoot(),
    findActiveRootsByKind('SOURCE'),
    categoryHomeOf(categoryHomeOverride)
  ])
  const sourceVOs = await Promise.all(
    sources.map(async (root) => toSourceRootVO(root, byRoot.get(root.id) ?? 0, await hasChildDirs(root.path)))
  )
  return {
    counts: toSidebarCountsVO(counts),
    sources: sourceVOs,
    categories: await listCategoryDirs(home)
  }
}

// 导入一个源目录：必须是存在的目录；不能与已导入目录重复或互相嵌套，也不能和类目录所在的图库文件夹重叠
export async function addRoot(rawPath: string, categoryHomeOverride: string | null): Promise<LibraryRootVO> {
  const path = resolve(rawPath)
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) {
    throw new BizError('BAD_REQUEST', `目录不存在：${path}`)
  }
  const home = await categoryHomeOf(categoryHomeOverride)
  if (isWithin(home, path) || isWithin(path, home)) {
    throw new BizError('CONFLICT', `和类目录所在的文件夹重叠：${home}`)
  }
  const existing = await findActiveRoots()
  const overlap = existing.find((r) => isWithin(r.path, path) || isWithin(path, r.path))
  if (overlap) {
    throw new BizError('CONFLICT', `与已导入的目录重叠：${overlap.path}`)
  }
  const created = await insertRoot({ kind: 'SOURCE', name: basename(path) || path, path })
  return toLibraryRootVO(created)
}
