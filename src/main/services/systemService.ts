import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, stat, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { CUSTOM_BACKGROUND_NAME, type AppSettings } from '@shared/settings'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { publishExclusive } from '../common/publishFile'
import { atomicWriteFile, retryOnWinBusy } from '../common/winFs'
import { getDatabase } from '../db/client'
import { findAllContentHashes } from '../repositories/imageRepository'
import { updateSettings } from './settingsService'
import { openBmp } from './scan/bmpDecoder'
import { formatOfFile } from './scan/formats'

const log = getLogger('system')

// 缩略图文件名：内容哈希 + .webp
const THUMB_FILE = /^([0-9a-f]{64})\.webp$/
// 自定义背景图最长边（再大也看不出区别，只会占内存）
const BACKGROUND_MAX_EDGE = 2560
// 文件被占用时重试几次、每次隔多久
const BUSY_RETRIES = 8
const BUSY_WAIT_MS = 250

// 一个文件夹里文件的总大小（只算第一层，缩略图是平铺的）
export async function folderBytes(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[])
  let total = 0
  for (const name of names) {
    total += await stat(join(dir, name)).then(
      (s) => (s.isFile() ? s.size : 0),
      () => 0
    )
  }
  return total
}

// 清理缩略图缓存：删掉库里已经没有对应图片的缩略图（还在用的不动，免得网格变成占位要重新生成）
export async function cleanThumbCache(thumbsDir: string): Promise<{ removed: number; freedBytes: number }> {
  const keep = new Set(await findAllContentHashes())
  const names = await readdir(thumbsDir).catch(() => [] as string[])
  let removed = 0
  let freedBytes = 0
  for (const name of names) {
    const m = THUMB_FILE.exec(name)
    if (!m || keep.has(m[1])) {
      continue
    }
    const file = join(thumbsDir, name)
    try {
      const { size } = await stat(file)
      await unlink(file)
      removed++
      freedBytes += size
    } catch (err) {
      log.warn(`删除缩略图失败：${name}`, err)
    }
  }
  log.info(`清理缩略图缓存：删除 ${removed} 个，${freedBytes} 字节`)
  return { removed, freedBytes }
}

// 备份文件的默认名：诺诺图床备份-年月日-时分.tar.gz
export function backupFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `诺诺图床备份-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.tar.gz`
}

// 导出备份：把整个图库数据库（图片记录、标签、名字、设置）打包压缩写到 target；图片文件本身不在里面
export async function exportBackup(target: string): Promise<number> {
  const { pg } = getDatabase()
  const dump = await pg.dumpDataDir('gzip')
  const bytes = Buffer.from(await dump.arrayBuffer())
  const staging = join(dirname(target), `.ltm-backup-${randomUUID()}.tmp`)
  try {
    const file = await open(staging, 'wx')
    try {
      await writeAndClose(file, bytes)
      await publishExclusive(staging, target)
    } finally {
      await unlinkWithRetry(staging).catch((err: unknown) => log.warn('无法清理临时备份文件', err))
    }
  } catch (err) {
    const cause = err as NodeJS.ErrnoException
    throw new BizError('DEPENDENCY_FAILED', cause.code === 'EEXIST' ? '这个位置已经有同名文件了' : `备份写不进去：${cause.message}`)
  }
  log.info(`已导出备份：${target}（${bytes.length} 字节）`)
  return bytes.length
}

async function writeAndClose(file: FileHandle, bytes: Buffer): Promise<void> {
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
}

// 删一个文件；刚写好的文件可能正被杀毒软件扫描（EBUSY / EPERM / EACCES），隔一会儿再试几次
async function unlinkWithRetry(file: string, tries = BUSY_RETRIES): Promise<void> {
  const delays = Array.from({ length: Math.max(0, tries - 1) }, () => BUSY_WAIT_MS)
  try {
    await retryOnWinBusy(() => unlink(file), delays)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

const AUTO_SNAPSHOT_FILE = /^auto-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz$/
const AUTO_SNAPSHOT_GLOB = /^auto-.*\.tar\.gz$/
const DEFAULT_SNAPSHOT_KEEP = 3
const DEFAULT_SNAPSHOT_INTERVAL_MS = 24 * 3600 * 1000

function autoSnapshotName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `auto-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.tar.gz`
}

function snapshotTimeMs(name: string, mtimeMs: number): number {
  const m = AUTO_SNAPSHOT_FILE.exec(name)
  if (!m) return mtimeMs
  const parsed = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
  return Number.isFinite(parsed) ? parsed : mtimeMs
}

// 定期自动快照轮转：清理残留 .tmp，间隔不足 minIntervalMs 时跳过，超出 keep 份时按时间清理最旧快照
export async function rotateAutoSnapshot(
  snapshotsDir: string,
  options?: { keep?: number; minIntervalMs?: number; now?: Date }
): Promise<string | null> {
  const keep = options?.keep ?? DEFAULT_SNAPSHOT_KEEP
  const minIntervalMs = options?.minIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS
  const now = options?.now ?? new Date()
  await mkdir(snapshotsDir, { recursive: true })
  const entries = await readdir(snapshotsDir)
  for (const name of entries) {
    if (name.endsWith('.tmp')) {
      await retryOnWinBusy(() => unlink(join(snapshotsDir, name))).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`清理临时快照失败：${name}`, err)
        }
      })
    }
  }
  const existing: Array<{ name: string; timeMs: number }> = []
  for (const name of entries) {
    if (!AUTO_SNAPSHOT_GLOB.test(name)) continue
    const info = await stat(join(snapshotsDir, name)).catch(() => null)
    if (!info || !info.isFile() || info.size <= 0) continue
    existing.push({ name, timeMs: snapshotTimeMs(name, info.mtimeMs) })
  }
  existing.sort((a, b) => b.timeMs - a.timeMs || b.name.localeCompare(a.name))
  const newest = existing[0]
  if (newest && now.getTime() - newest.timeMs < minIntervalMs) {
    return null
  }
  const { pg } = getDatabase()
  const dump = await pg.dumpDataDir('gzip')
  const bytes = Buffer.from(await dump.arrayBuffer())
  const filename = autoSnapshotName(now)
  const target = join(snapshotsDir, filename)
  await atomicWriteFile(target, bytes)
  const updated = [{ name: filename, timeMs: now.getTime() }, ...existing.filter((item) => item.name !== filename)]
    .sort((a, b) => b.timeMs - a.timeMs || b.name.localeCompare(a.name))
  const stale = updated.slice(Math.max(0, keep))
  for (const item of stale) {
    await retryOnWinBusy(() => unlink(join(snapshotsDir, item.name))).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`清理旧快照失败：${item.name}`, err)
      }
    })
  }
  log.info(`已生成自动快照：${target}（保留 ${Math.min(updated.length, Math.max(0, keep))} 份）`)
  return target
}

// 删掉 backgrounds 里除了 keep 以外的旧背景图；还被占用的留到下次（换图或启动时）再删
export async function pruneBackgrounds(bgDir: string, keep: string | null): Promise<void> {
  const names = await readdir(bgDir).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name !== keep && CUSTOM_BACKGROUND_NAME.test(name))
      .map((name) => unlinkWithRetry(join(bgDir, name)).catch((err: unknown) => log.warn(`旧背景图删不掉，下次再删：${name}`, err)))
  )
}

let backgroundSave: Promise<void> = Promise.resolve()

// 按选图顺序提交。数据库确认新文件后，才能清理仍在使用的旧背景。
export function importCustomBackground(source: string, bgDir: string, now = Date.now()): Promise<AppSettings> {
  const save = backgroundSave.then(() => saveBackground(source, bgDir, now))
  backgroundSave = save.then(() => undefined, () => undefined)
  return save
}

async function saveBackground(source: string, bgDir: string, now: number): Promise<AppSettings> {
  await mkdir(bgDir, { recursive: true })
  let bytes: Buffer
  try {
    const input = formatOfFile(source) === 'BMP' ? openBmp(await readFile(source)) : sharp(source, { limitInputPixels: 400_000_000 })
    if (!input) throw new Error('不支持或已损坏的 BMP')
    bytes = await input
      .rotate()
      .resize({ width: BACKGROUND_MAX_EDGE, height: BACKGROUND_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer()
  } catch (err) {
    log.warn(`背景图读不了：${source}`, err)
    throw new BizError('BAD_REQUEST', '这张图读不了，换一张试试')
  }
  for (let stamp = now; ; stamp++) {
    const name = `custom-${stamp}.webp`
    const file = await open(join(bgDir, name), 'wx').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return null
      throw err
    })
    if (!file) continue
    await writeAndClose(file, bytes)
    const settings = await updateSettings({ background: 'custom', customBackground: name })
    await pruneBackgrounds(bgDir, name)
    return settings
  }
}

// 开机自动启动只在正式使用（没设 LTM_DATA_DIR）时改系统登记，开发和测试不碰
export function canTouchLoginItem(env: NodeJS.ProcessEnv): boolean {
  return !env.LTM_DATA_DIR
}
