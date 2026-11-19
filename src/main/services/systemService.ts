import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { CUSTOM_BACKGROUND_NAME } from '@shared/settings'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { getDatabase } from '../db/client'
import { findAllContentHashes } from '../repositories/imageRepository'

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
  await writeFile(target, bytes, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    throw new BizError('DEPENDENCY_FAILED', err.code === 'EEXIST' ? '这个位置已经有同名文件了' : `备份写不进去：${err.message}`)
  })
  log.info(`已导出备份：${target}（${bytes.length} 字节）`)
  return bytes.length
}

// 删一个文件；刚写好的文件可能正被杀毒软件扫描（EBUSY / EPERM），隔一会儿再试几次
async function unlinkWithRetry(file: string, tries = BUSY_RETRIES): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await unlink(file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return
      }
      if ((code !== 'EBUSY' && code !== 'EPERM') || i >= tries - 1) {
        throw err
      }
      await new Promise((r) => setTimeout(r, BUSY_WAIT_MS))
    }
  }
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

// 导入自定义背景：缩到最长边 2560、转成 webp 存进 backgrounds，顺手删掉旧的；返回新文件名
export async function importCustomBackground(source: string, bgDir: string, now = Date.now()): Promise<string> {
  await mkdir(bgDir, { recursive: true })
  const name = `custom-${now}.webp`
  try {
    await sharp(source, { limitInputPixels: 400_000_000 })
      .rotate()
      .resize({ width: BACKGROUND_MAX_EDGE, height: BACKGROUND_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toFile(join(bgDir, name))
  } catch (err) {
    log.warn(`背景图读不了：${source}`, err)
    throw new BizError('BAD_REQUEST', '这张图读不了，换一张试试')
  }
  await pruneBackgrounds(bgDir, name)
  return name
}

// 开机自动启动只在正式使用（没设 LTM_DATA_DIR）时改系统登记，开发和测试不碰
export function canTouchLoginItem(env: NodeJS.ProcessEnv): boolean {
  return !env.LTM_DATA_DIR
}
