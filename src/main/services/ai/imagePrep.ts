// 发给云端之前的图：按 EXIF 转正、缩到长边上限、去掉元信息，转成 JPEG 的 data URL
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import sharp from 'sharp'
import { openBmp } from '../scan/bmpDecoder'
import { formatOfFile } from '../scan/formats'
import { hashBuffer, hashFile, READ_ONCE_LIMIT } from '../scan/imageProbe'

// 一张图可以从哪里读：原图位置（可能读不了，如 RAW、目录离线），再退到缩略图
export interface ImageSource {
  rootPath: string | null
  relPath: string | null
  contentHash: string
}

// 依次试原图、缩略图；都读不了返回 null
export async function prepareImage(src: ImageSource, thumbsDir: string, longEdge: number): Promise<string | null> {
  const thumbnail = () => toDataUrl(join(thumbsDir, `${src.contentHash}.webp`), longEdge).catch(() => null)
  if (!src.rootPath || !src.relPath) return thumbnail()
  const file = join(src.rootPath, src.relPath)
  try {
    // 目录监听可能还未刷新。同一份字节完成校验和解码，避免把替换后的文件当成已分级的原图。
    if ((await stat(file)).size <= READ_ONCE_LIMIT) {
      const bytes = await readFile(file)
      return hashBuffer(bytes) === src.contentHash ? await toDataUrl(bytes, longEdge) : thumbnail()
    }
    const cached = await thumbnail()
    if (cached) return cached
    // 超大原图没有缓存时，用磁盘副本核验，避免为了计算哈希一次分配整份原图。
    const dir = await mkdtemp(join(tmpdir(), 'ltm-image-'))
    try {
      const snapshot = join(dir, 'original' + extname(file))
      await copyFile(file, snapshot)
      return await hashFile(snapshot) === src.contentHash ? await toDataUrl(snapshot, longEdge) : null
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } catch {
    return thumbnail()
  }
}

// 一个文件或一段图片数据转成 data URL
export async function toDataUrl(input: string | Buffer, longEdge: number): Promise<string> {
  const source = typeof input === 'string' && formatOfFile(input) === 'BMP' ? await readFile(input) : input
  const image = Buffer.isBuffer(source) && source[0] === 0x42 && source[1] === 0x4d
    ? openBmp(source) : sharp(source, { animated: false, failOn: 'none' })
  if (!image) throw new Error('无法读取这张 BMP 图片')
  const buf = await image
    .rotate()
    .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}
