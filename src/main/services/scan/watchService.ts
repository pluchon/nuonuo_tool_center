import { existsSync, realpath, watch, type FSWatcher } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { getLogger } from '../../common/logger'
import { isSkippedDir, isWithin, pathKey } from '../../common/pathUtil'
import { findScanRowsByRoot, hasNormalFilesUnder } from '../../repositories/imageFileRepository'
import { findActiveRoots } from '../../repositories/libraryRootRepository'
import { getSettings } from '../settingsService'
import { formatOfFile, shouldProcess } from './formats'

const log = getLogger('watch')
const nativeRealpath = promisify(realpath.native)

// 一阵变化（复制一批图、解压）停下来多久后再扫，免得每个文件扫一次
export const WATCH_SETTLE_MS = 1500

// 有变化的目录要重扫时调这个（默认排进扫描队列）
export type RescanFn = (rootId: number) => void

// 应用自己改文件（移动、复制、删除、新建 / 改名目录）时和之后这么久内的变化不算外部变化，免得自己触发重扫、挡住撤销
export const SELF_CHANGE_GRACE_MS = 2500

let rescan: RescanFn = () => undefined
let isScanning: (rootId: number) => boolean = () => false
let selfBusy = 0
let selfUntil = 0
// 每个目录一个递归监听（Windows 上只占着目录本身，子文件夹照常能改名、删除；chokidar 会给每个子文件夹各开一个监听，挡住改名）
interface DirectoryWatch {
  id: number
  path: string
  handle: FSWatcher
  changes: Map<string, boolean>
  timer?: ReturnType<typeof setTimeout>
  checking: boolean
}
const watchers = new Map<number, DirectoryWatch>()
let refreshVersion = 0
const CHECK_BATCH_SIZE = 32

export function configureWatch(fn: RescanFn, scanning: (rootId: number) => boolean): void {
  rescan = fn
  isScanning = scanning
}

// 普通变更只核对图片。创建、移除和重命名还可能涉及名称带点的目录。
export function isIgnoredChange(rel: string, renamed: boolean): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  return parts.length === 0 || parts.some(isSkippedDir) || (!renamed && formatOfFile(basename(rel)) === null)
}

// 包住应用自己的文件操作：做的时候和做完后一小段时间里，监听到的变化都忽略
export async function muteWhile<T>(task: () => Promise<T>): Promise<T> {
  selfBusy++
  try {
    return await task()
  } finally {
    selfBusy--
    selfUntil = Date.now() + SELF_CHANGE_GRACE_MS
  }
}

// 现在的变化是不是应用自己造成的
export function isSelfChange(now = Date.now()): boolean {
  return selfBusy > 0 || now < selfUntil
}

// 被监听的目录本身被删掉（或移走）时，Windows 上的递归监听会不停地报带 \\?\ 前缀的绝对路径，一秒几万次，把主进程占满。
// 回调里给的是绝对路径就看看目录还在不在：不在了马上关掉这个监听，重扫一次（扫描会把它标成“找不到”）
export function isRootGoneSignal(rel: string): boolean {
  return rel.startsWith('\\\\?\\') || isAbsolute(rel)
}

// 只读取通知涉及的文件元数据。访问时间和普通目录属性变化与图库内容无关。
async function hasLibraryChange(entry: DirectoryWatch, changes: Map<string, boolean>): Promise<boolean> {
  const { scanFormats, skipSmall } = await getSettings()
  const paths = [...changes.keys()]
  for (let offset = 0; offset < paths.length; offset += CHECK_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + CHECK_BATCH_SIZE)
    const rows = await findScanRowsByRoot(entry.id, batch.map(pathKey))
    const indexed = new Map(rows.map((file) => [pathKey(file.relPath), file]))
    const results = await Promise.all(batch.map(async (rel) => {
      const key = pathKey(rel)
      const previous = indexed.get(key)
      const renamed = changes.get(rel)
      const absolute = join(entry.path, rel)
      const info = await lstat(absolute).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
        throw err
      })
      if (!info) {
        return previous?.status === 'NORMAL' || (renamed && await hasNormalFilesUnder(entry.id, `${key}${sep}`))
      }
      if (info.isDirectory()) return renamed
      const format = formatOfFile(rel)
      if (!info.isFile() || !format || !shouldProcess(format, info.size, scanFormats, skipSmall)) return false
      if (previous?.status !== 'NORMAL' || info.size !== previous.byteSize || info.mtime.getTime() !== previous.mtime.getTime()) return true
      if (!renamed || previous.relPath === rel) return false
      // Windows 会同时报告旧名称和新名称。以磁盘上的实际拼写为准，避免旧通知再次触发。
      const [actualRoot, actualFile] = await Promise.all([nativeRealpath(entry.path), nativeRealpath(absolute)])
      const actual = relative(actualRoot, actualFile)
      return pathKey(actual) === key && previous.relPath !== actual
    }).map((result) => result.catch((err: unknown) => {
      log.debug(`无法核对目录 ${entry.id} 的文件变更`, err)
      return false
    })))
    if (results.some(Boolean)) return true
  }
  return false
}

function schedule(entry: DirectoryWatch): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    void checkChanges(entry).catch((err: unknown) => log.warn(`核对目录 ${entry.id} 的变化失败`, err))
  }, WATCH_SETTLE_MS)
}

async function checkChanges(entry: DirectoryWatch): Promise<void> {
  if (watchers.get(entry.id) !== entry || entry.checking || entry.changes.size === 0) return
  // 等当前扫描把结果写入数据库后再核对，避免同一批变化触发两次扫描。
  if (isScanning(entry.id)) {
    schedule(entry)
    return
  }
  entry.checking = true
  const changes = entry.changes
  entry.changes = new Map()
  try {
    const changed = await hasLibraryChange(entry, changes)
    if (watchers.get(entry.id) !== entry) return
    if (isScanning(entry.id)) {
      for (const [rel, renamed] of changes) entry.changes.set(rel, renamed || entry.changes.get(rel) === true)
    } else if (changed) {
      log.info(`目录 ${entry.id} 有文件变化，重新扫描`)
      rescan(entry.id)
    }
  } finally {
    entry.checking = false
    if (watchers.get(entry.id) === entry && entry.changes.size > 0 && !entry.timer) schedule(entry)
  }
}

function closeWatch(entry: DirectoryWatch): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.handle.close()
  watchers.delete(entry.id)
}

export async function stopWatching(): Promise<void> {
  refreshVersion++
  for (const entry of watchers.values()) closeWatch(entry)
}

function reportMissingRoot(entry: DirectoryWatch): void {
  log.warn(`目录 ${entry.id} 不见了，停止监听：${entry.path}`)
  closeWatch(entry)
  rescan(entry.id)
}

// 保留没变的监听及其待核对通知。关闭设置时使尚未返回的刷新失效。
export async function refreshWatching(enabled: boolean): Promise<void> {
  if (!enabled) {
    await stopWatching()
    return
  }
  const version = ++refreshVersion
  const next = new Map((await findActiveRoots()).map((r) => [r.id, r.path]))
  if (version !== refreshVersion) return
  for (const [id, entry] of watchers) {
    if (next.get(id) !== entry.path) closeWatch(entry)
  }
  for (const [id, root] of next) {
    if (watchers.has(id)) continue
    try {
      const handle = watch(root, { recursive: true }, (event, file) => {
        if (watchers.get(id) !== entry) return
        if (!file || isRootGoneSignal(file)) {
          if (!existsSync(root)) reportMissingRoot(entry)
          return
        }
        const rel = normalize(file)
        const renamed = event === 'rename'
        if (isSelfChange() || isIgnoredChange(rel, renamed) || !isWithin(root, join(root, rel))) return
        entry.changes.set(rel, renamed || entry.changes.get(rel) === true)
        schedule(entry)
      })
      const entry: DirectoryWatch = { id, path: root, handle, changes: new Map(), checking: false }
      watchers.set(id, entry)
      handle.on('error', (err: unknown) => {
        if (watchers.get(id) !== entry) return
        if (!existsSync(root)) {
          reportMissingRoot(entry)
        } else {
          log.warn(`目录 ${id} 的文件监听出错`, err)
          closeWatch(entry)
        }
      })
      log.info(`开始实时监听目录 ${id}`)
    } catch (err) {
      // 目录不在（移动硬盘没接）：先不监听，接回来扫描后重建
      log.warn(`目录 ${id} 暂时监听不了：${root}`, err)
    }
  }
}

// 按设置里“实时监听文件变化”同步一次（目录有增删、扫描做完、设置改了以后调）；出错只记日志
export async function syncWatching(): Promise<void> {
  try {
    await refreshWatching((await getSettings()).watchChanges)
  } catch (err) {
    log.warn('更新实时监听失败', err)
  }
}
