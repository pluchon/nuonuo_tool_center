// 发给云端之前的图：按 EXIF 转正、缩到长边上限、去掉元信息，转成 JPEG 的 data URL
import { join } from 'node:path'
import sharp from 'sharp'

// 一张图可以从哪里读：原图位置（可能读不了，如 RAW、目录离线），再退到缩略图
export interface ImageSource {
  rootPath: string | null
  relPath: string | null
  contentHash: string
}

// 依次试原图、缩略图；都读不了返回 null
export async function prepareImage(src: ImageSource, thumbsDir: string, longEdge: number): Promise<string | null> {
  const tries = [src.rootPath && src.relPath ? join(src.rootPath, src.relPath) : null, join(thumbsDir, `${src.contentHash}.webp`)]
  for (const file of tries) {
    if (!file) {
      continue
    }
    try {
      return await toDataUrl(file, longEdge)
    } catch {
      // 换下一个来源
    }
  }
  return null
}

// 一个文件或一段图片数据转成 data URL
export async function toDataUrl(input: string | Buffer, longEdge: number): Promise<string> {
  const buf = await sharp(input, { animated: false, failOn: 'none' })
    .rotate()
    .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}
