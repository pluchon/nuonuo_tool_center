import { readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { CategoryDirVO, LibraryOverviewVO, LibraryRootVO } from '@shared/api'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { isSkippedDir, isWithin } from '../common/pathUtil'
import { toLibraryRootVO, toSidebarCountsVO, toSourceRootVO } from '../converter/libraryConverter'
import { countImagesByRoot, countImagesByTopFolder, countOverview } from '../repositories/libraryOverviewRepository'
import {
  findActiveRootById,
  findActiveRoots,
  findActiveRootsByKind,
  insertRoot,
  updateRootPath
} from '../repositories/libraryRootRepository'
import { categoryHomeOf } from './categoryHome'
import { startScan } from './scan/scanService'

const log = getLogger('library')

// “最近导入”统计的天数
const RECENT_DAYS = 30

// 列出某个目录下的子文件夹名（跳过隐藏和系统目录）；目录不存在时返回 null，其它读取错误照常抛出
export async function childDirs(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !isSkippedDir(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

// 某个目录有没有子文件夹；读不了（比如移动硬盘没接）按没有处理，只记一条日志，不影响显示
export async function hasChildDirs(dir: string): Promise<boolean> {
  try {
    return ((await childDirs(dir)) ?? []).length > 0
  } catch (err) {
    log.info(`读取子文件夹失败：${dir}`, err)
    return false
  }
}

// 目录现在能不能访问
async function isReachableDir(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false)
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

// 侧栏和底栏需要的全部数据：计数、源目录（含是否找不到）、顶层类目录、最近扫描时间
export async function getOverview(categoryHomeOverride: string | null): Promise<LibraryOverviewVO> {
  const [counts, byRoot, roots, home] = await Promise.all([
    countOverview(RECENT_DAYS),
    countImagesByRoot(),
    findActiveRoots(),
    categoryHomeOf(categoryHomeOverride)
  ])
  const sources = roots.filter((r) => r.kind === 'SOURCE')
  const sourceVOs = await Promise.all(
    sources.map(async (root) => {
      const reachable = await isReachableDir(root.path)
      return toSourceRootVO(root, byRoot.get(root.id) ?? 0, reachable && (await hasChildDirs(root.path)), !reachable)
    })
  )
  // 底栏的扫描时间只看源目录：还没有源目录时显示“还没有扫描过”
  const scanTimes = sources.map((r) => r.lastScanAt?.getTime() ?? 0).filter((t) => t > 0)
  return {
    counts: toSidebarCountsVO(counts),
    sources: sourceVOs,
    categories: await listCategoryDirs(home),
    lastScanAt: scanTimes.length > 0 ? new Date(Math.max(...scanTimes)).toISOString() : null
  }
}

// 检查一个文件夹能不能作为源目录：必须存在；不能和类目录所在的图库文件夹重叠，也不能和其它源目录重复或互相嵌套
async function checkSourcePath(rawPath: string, categoryHomeOverride: string | null, selfId: number | null): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new BizError('BAD_REQUEST', '没有选择文件夹')
  }
  const path = resolve(rawPath)
  if (!(await isReachableDir(path))) {
    throw new BizError('BAD_REQUEST', `目录不存在：${path}`)
  }
  const home = await categoryHomeOf(categoryHomeOverride)
  if (isWithin(home, path) || isWithin(path, home)) {
    throw new BizError('CONFLICT', `和类目录所在的文件夹重叠：${home}`)
  }
  const existing = (await findActiveRootsByKind('SOURCE')).filter((r) => r.id !== selfId)
  const overlap = existing.find((r) => isWithin(r.path, path) || isWithin(path, r.path))
  if (overlap) {
    throw new BizError('CONFLICT', `与已导入的目录重叠：${overlap.path}`)
  }
  return path
}

// 导入一个源目录并开始扫描它
export async function addRoot(rawPath: string, categoryHomeOverride: string | null): Promise<LibraryRootVO> {
  const path = await checkSourcePath(rawPath, categoryHomeOverride, null)
  const created = await insertRoot({ kind: 'SOURCE', name: basename(path) || path, path })
  startScan(created.id)
  return toLibraryRootVO(created)
}

// 源目录找不到时重新选择位置：名字不变，按新位置重新扫描，标签都还在（按内容哈希认回）
export async function relocateRoot(id: number, rawPath: string, categoryHomeOverride: string | null): Promise<LibraryRootVO> {
  const root = await findActiveRootById(id)
  if (!root || root.kind !== 'SOURCE') {
    throw new BizError('NOT_FOUND', '这个源目录已经不在图库里了')
  }
  const path = await checkSourcePath(rawPath, categoryHomeOverride, id)
  const updated = await updateRootPath(id, path)
  startScan(id)
  return toLibraryRootVO(updated)
}
