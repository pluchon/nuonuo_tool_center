import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import sharp from 'sharp'
import type { ScanFormat } from '@shared/settings'
import { getLogger } from '../../common/logger'
import { retryOnWinBusy } from '../../common/winFs'
import { openBmp } from './bmpDecoder'
import { parseExif, type ExifInfo, type ParsedExif } from './exifInfo'
import { hasTiffHeader, largestEmbeddedJpeg } from './rawPreview'

const log = getLogger('scan')

// sharp 的图片对象类型
type SharpImage = ReturnType<typeof sharp>

// 缩略图尺寸：网格行高最大约 260px，高分屏按 1.5 倍；宽度给到 2.5 的长宽比上限
const THUMB_BOX = { width: 1000, height: 400 }
const THUMB_QUALITY = 78

// 一次读进内存的文件大小上限：更大的（超大 RAW、全景图）流式算哈希、按路径解码。4 路同时处理时最多占约 256 MB
export const READ_ONCE_LIMIT = 64 * 1024 * 1024
// 缩略图 webp 的压缩力度：2 比默认的 4 快不少，文件只大一点点，看不出区别
const THUMB_EFFORT = 2

// 扫描时 sharp 只用 1 个线程、不留缓存（核显笔记本，避免整机卡顿；并发由扫描服务控制）
sharp.concurrency(1)
sharp.cache(false)

// 图片解析结果：尺寸、拍摄信息；thumbnail 表示这次是否成功写出了缩略图
export interface ImageAnalysis {
  width: number | null
  height: number | null
  exif: ExifInfo | null
  takenAt: Date | null
  thumbnail: boolean
}

// 内存里内容的 sha256
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// 流式计算文件的 sha256（超大文件用）
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

// 准备给 sharp 的输入：已经读进内存的直接用（在 Windows 上比按路径打开快很多）；RAW 取内嵌 JPEG；BMP 自己解码。拿不到可解码的输入时为 null
async function decodeInput(path: string, format: ScanFormat, data: Buffer | null): Promise<{ input: SharpImage | null; exifSource: Buffer | null }> {
  if (format === 'RAW') {
    const buf = data ?? (await readFile(path))
    const preview = largestEmbeddedJpeg(buf)
    return { input: preview ? sharp(preview, { failOn: 'error' }) : null, exifSource: hasTiffHeader(buf) ? buf : null }
  }
  if (format === 'BMP') {
    return { input: openBmp(data ?? (await readFile(path))), exifSource: null }
  }
  return { input: sharp(data ?? path, { failOn: 'error' }), exifSource: null }
}

// 把解析出的拍摄信息和拍摄时间写进结果
function applyExif(result: ImageAnalysis, parsed: ParsedExif): void {
  result.exif = parsed.info
  result.takenAt = parsed.takenAt
}

// 读尺寸和 EXIF，并在 thumbPath 不为空时生成缩略图（先写临时文件再改名，不留半截文件）。解不出来时尺寸为空、thumbnail 为 false。
// data 是已经读进内存的文件内容（扫描时算哈希顺便读的），没有就按路径读
export async function analyzeImage(path: string, format: ScanFormat, thumbPath: string | null, data: Buffer | null = null): Promise<ImageAnalysis> {
  const result: ImageAnalysis = { width: null, height: null, exif: null, takenAt: null, thumbnail: false }
  let decoded: Awaited<ReturnType<typeof decodeInput>>
  try {
    decoded = await decodeInput(path, format, data)
  } catch (err) {
    log.info(`读不出图片：${path}`, err)
    return result
  }
  const { input, exifSource } = decoded
  if (!input) {
    applyExif(result, parseExif(exifSource))
    return result
  }
  try {
    const meta = await input.metadata()
    // 动图的 height 是所有帧叠起来的高度，单帧高度在 pageHeight
    const h = meta.pages && meta.pages > 1 && meta.pageHeight ? meta.pageHeight : meta.height
    // EXIF 方向 5–8 表示需要转 90°，宽高对调
    const swap = (meta.orientation ?? 1) >= 5
    result.width = (swap ? h : meta.width) ?? null
    result.height = (swap ? meta.width : h) ?? null
    applyExif(result, parseExif(exifSource ?? meta.exif))
  } catch (err) {
    log.info(`解不出图片：${path}`, err)
    applyExif(result, parseExif(exifSource))
    return result
  }
  if (thumbPath) {
    result.thumbnail = await writeThumbnail(input, thumbPath)
  }
  return result
}

// 写缩略图：按 EXIF 方向转正、缩到 THUMB_BOX 以内（不放大），存成 webp；目标已存在时不覆盖
async function writeThumbnail(input: SharpImage, thumbPath: string): Promise<boolean> {
  const tmp = `${thumbPath}.${randomUUID()}.tmp`
  try {
    await input
      .clone()
      .rotate()
      .resize({ ...THUMB_BOX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY, effort: THUMB_EFFORT })
      .toFile(tmp)
    if (existsSync(thumbPath)) {
      await retryOnWinBusy(() => rm(tmp, { force: true }))
    } else {
      await retryOnWinBusy(() => rename(tmp, thumbPath))
    }
    return true
  } catch (err) {
    log.info(`生成缩略图失败：${thumbPath}`, err)
    await retryOnWinBusy(() => rm(tmp, { force: true })).catch(() => undefined)
    return false
  }
}
