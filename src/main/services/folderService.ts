import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { shell } from 'electron'
import type { DirNodeVO, FolderNodeVO, FolderRefDTO, TransferRootsVO } from '@shared/api'
import { countImagesByChildFolder } from '../repositories/libraryOverviewRepository'
import { resolveFolder } from './fileOps/folderOpsService'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { isWithin } from '../common/pathUtil'
import { findActiveRootsByKind } from '../repositories/libraryRootRepository'
import { categoryHomeOf } from './categoryHome'
import { childDirs, hasChildDirs } from './libraryService'

const log = getLogger('folder')

// 探测盘符的超时：断开的网络盘可能卡很久
const DRIVE_PROBE_TIMEOUT = 1500
// A、B 是软驱位，不探测
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

// 一个盘符现在能不能访问
async function driveReady(root: string): Promise<boolean> {
  const probe = stat(root)
    .then(() => true)
    .catch(() => false)
  const timeout = new Promise<boolean>((done) => setTimeout(() => done(false), DRIVE_PROBE_TIMEOUT))
  return Promise.race([probe, timeout])
}

// 列出导入对话框的一层：parent 为空时列盘符，否则列它下面的子文件夹，并标出哪些不能选
export async function listFolders(parent: string | null, categoryHomeOverride: string | null): Promise<FolderNodeVO[]> {
  if (parent === null) {
    const drives = await Promise.all(
      DRIVE_LETTERS.map(async (letter) => ((await driveReady(`${letter}:\\`)) ? letter : null))
    )
    const ready = drives.filter((d): d is string => d !== null)
    return Promise.all(
      ready.map(async (letter) => ({
        path: `${letter}:\\`,
        label: `${letter}: 盘`,
        isDrive: true,
        hasChildren: await hasChildDirs(`${letter}:\\`),
        lock: null
      }))
    )
  }
  if (typeof parent !== 'string' || parent.trim() === '') {
    throw new BizError('BAD_REQUEST', '文件夹路径不对')
  }
  const base = resolve(parent)
  let names: string[] | null
  try {
    names = await childDirs(base)
  } catch (err) {
    log.info(`列子文件夹失败：${base}`, err)
    throw new BizError('DEPENDENCY_FAILED', `打不开这个文件夹：${base}`)
  }
  if (!names) {
    throw new BizError('NOT_FOUND', `文件夹不存在：${base}`)
  }
  const home = await categoryHomeOf(categoryHomeOverride)
  const sources = (await findActiveRootsByKind('SOURCE')).map((r) => r.path)
  return Promise.all(
    names.map(async (name) => {
      const path = join(base, name)
      return { path, label: name, isDrive: false, hasChildren: await hasChildDirs(path), lock: lockOf(path, home, sources) }
    })
  )
}

// 侧栏目录树展开一层：列出磁盘上的子文件夹和各自的图片数（含更深的子目录）
export async function dirChildren(ref: FolderRefDTO): Promise<DirNodeVO[]> {
  const folder = await resolveFolder(ref)
  let names: string[] | null
  try {
    names = await childDirs(folder.abs)
  } catch (err) {
    log.info(`列子文件夹失败：${folder.abs}`, err)
    throw new BizError('DEPENDENCY_FAILED', `打不开这个文件夹：${folder.abs}`)
  }
  const counts = folder.root ? await countImagesByChildFolder(folder.root.id, folder.rel) : new Map<string, number>()
  return Promise.all(
    (names ?? []).map(async (name) => ({
      name,
      rel: folder.rel ? `${folder.rel}\\${name}` : name,
      count: counts.get(name.toLowerCase()) ?? 0,
      hasChildren: await hasChildDirs(join(folder.abs, name))
    }))
  )
}

// 在资源管理器里打开一个目录
export async function openFolder(ref: FolderRefDTO): Promise<void> {
  const folder = await resolveFolder(ref)
  const error = await shell.openPath(folder.abs)
  if (error) {
    throw new BizError('DEPENDENCY_FAILED', `打不开：${error}`)
  }
}

// 移动 / 复制对话框的顶层：全部源目录（找不到的标出来）、图库文件夹下的顶层类目录
export async function transferRoots(categoryHomeOverride: string | null): Promise<TransferRootsVO> {
  const roots = await findActiveRootsByKind('SOURCE')
  const sources = await Promise.all(
    roots.map(async (r) => {
      const online = await stat(r.path)
        .then((s) => s.isDirectory())
        .catch(() => false)
      return { id: r.id, path: r.path, label: r.name, offline: !online, hasChildren: online && (await hasChildDirs(r.path)) }
    })
  )
  const home = await categoryHomeOf(categoryHomeOverride)
  const names = (await childDirs(home).catch(() => null)) ?? []
  const categories = await Promise.all(
    names.map(async (name) => {
      const path = join(home, name)
      return { path, label: name, hasChildren: await hasChildDirs(path) }
    })
  )
  return { sources, categories, home }
}

// 不能选的原因：就是图库文件夹（或在它里面）/ 在已导入的源目录里 / 包含了已导入的源目录或图库文件夹
export function lockOf(path: string, home: string, sources: string[]): FolderNodeVO['lock'] {
  if (isWithin(home, path)) {
    return 'LIBRARY'
  }
  if (sources.some((s) => isWithin(s, path))) {
    return 'IMPORTED'
  }
  if (isWithin(path, home) || sources.some((s) => isWithin(path, s))) {
    return 'HOLDS'
  }
  return null
}
