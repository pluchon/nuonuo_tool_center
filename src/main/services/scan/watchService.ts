import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { getLogger } from '../../common/logger'
import { isSkippedDir, isWithin } from '../../common/pathUtil'
import { findActiveRoots, type LibraryRootEntity } from '../../repositories/libraryRootRepository'
import { getSettings } from '../settingsService'
import { formatOfFile } from './formats'

const log = getLogger('watch')

// 一阵变化（复制一批图、解压）停下来多久后再扫，免得每个文件扫一次
export const WATCH_SETTLE_MS = 1500

// 有变化的目录要重扫时调这个（默认排进扫描队列）
export type RescanFn = (rootId: number) => void

// 应用自己改文件（移动、复制、删除、新建 / 改名目录）时和之后这么久内的变化不算外部变化，免得自己触发重扫、挡住撤销
export const SELF_CHANGE_GRACE_MS = 2500

let rescan: RescanFn = () => undefined
let selfBusy = 0
let selfUntil = 0
// 每个目录一个递归监听（Windows 上只占着目录本身，子文件夹照常能改名、删除；chokidar 会给每个子文件夹各开一个监听，挡住改名）
let watchers: FSWatcher[] = []
// 正在监听的目录：id → 路径（用来判断要不要重建）
let watching = new Map<number, string>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function configureWatch(fn: RescanFn): void {
  rescan = fn
}

// 一条变化（相对目录的路径）要不要管：路径里有隐藏文件夹、回收站就不管；最后一段有扩展名的只管图片（没有扩展名的当文件夹）
export function isIgnoredChange(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) {
    return false
  }
  if (parts.slice(0, -1).some((p) => isSkippedDir(p))) {
    return true
  }
  const last = parts[parts.length - 1]
  if (isSkippedDir(last)) {
    return true
  }
  return /\.[^.\\/]+$/.test(last) && formatOfFile(basename(last)) === null
}

// 变化落在哪个目录（取最长匹配，类目录在源目录里不会出现，这里只是稳妥）
export function rootOf(path: string, roots: ReadonlyMap<number, string>): number | null {
  let best: { id: number; len: number } | null = null
  for (const [id, root] of roots) {
    if (isWithin(root, path) && (!best || root.length > best.len)) {
      best = { id, len: root.length }
    }
  }
  return best?.id ?? null
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

// 一个目录有变化：停下来一阵后重扫这个目录
function touch(path: string): void {
  if (isSelfChange()) {
    return
  }
  const id = rootOf(path, watching)
  if (id !== null) {
    schedule(id)
  }
}

// 被监听的目录本身被删掉（或移走）时，Windows 上的递归监听会不停地报带 \\?\ 前缀的绝对路径，一秒几万次，把主进程占满。
// 回调里给的是绝对路径就看看目录还在不在：不在了马上关掉这个监听，重扫一次（扫描会把它标成“找不到”）
export function isRootGoneSignal(rel: string): boolean {
  return rel.startsWith('\\\\?\\') || isAbsolute(rel)
}

// 排一次重扫（同一个目录在停下来之前的变化合成一次）
function schedule(id: number): void {
  const old = timers.get(id)
  if (old) {
    clearTimeout(old)
  }
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      log.info(`目录 ${id} 有文件变化，重新扫描`)
      rescan(id)
    }, WATCH_SETTLE_MS)
  )
}

// 停止监听
export async function stopWatching(): Promise<void> {
  for (const t of timers.values()) {
    clearTimeout(t)
  }
  timers.clear()
  const list = watchers
  watchers = []
  watching = new Map()
  for (const w of list) {
    w.close()
  }
}

// 按当前设置和目录列表开始 / 重建 / 停止监听；目录没变就什么都不做
export async function refreshWatching(enabled: boolean): Promise<void> {
  if (!enabled) {
    if (watchers.length > 0) {
      log.info('关闭实时监听')
      await stopWatching()
    }
    return
  }
  const roots: LibraryRootEntity[] = await findActiveRoots()
  const next = new Map(roots.map((r) => [r.id, r.path]))
  // 有目录上次没监听上（移动硬盘没接）时 watchers 会少，借这次重试
  const same = watchers.length === next.size && next.size === watching.size && [...next].every(([id, p]) => watching.get(id) === p)
  if (same) {
    return
  }
  await stopWatching()
  if (next.size === 0) {
    return
  }
  watching = next
  for (const [id, root] of next) {
    try {
      const w = watch(root, { recursive: true }, (_event, file) => {
        const rel = file ? String(file) : ''
        if (isRootGoneSignal(rel)) {
          if (!existsSync(root)) {
            log.warn(`目录 ${id} 不见了，停止监听：${root}`)
            w.close()
            watchers = watchers.filter((x) => x !== w)
            schedule(id)
          }
          return
        }
        if (!isIgnoredChange(rel)) {
          touch(rel ? join(root, rel) : root)
        }
      })
      // 目录被拔掉、删掉时监听会出错：记一下，下次扫描做完后重建
      w.on('error', (err: unknown) => log.warn(`目录 ${id} 的文件监听出错`, err))
      watchers.push(w)
    } catch (err) {
      // 目录不在（移动硬盘没接）：先不监听，接回来扫描后重建
      log.warn(`目录 ${id} 暂时监听不了：${root}`, err)
    }
  }
  log.info(`开始实时监听 ${watchers.length} 个目录`)
}

// 按设置里“实时监听文件变化”同步一次（目录有增删、扫描做完、设置改了以后调）；出错只记日志
export async function syncWatching(): Promise<void> {
  try {
    await refreshWatching((await getSettings()).watchChanges)
  } catch (err) {
    log.warn('更新实时监听失败', err)
  }
}
