// 系统原生拖拽（设计 5.2）：按住一会儿再拖，带出原文件，可以拖进 Telegram、资源管理器等别的软件
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, nativeImage, type NativeImage, type WebContents } from 'electron'
import sharp from 'sharp'
import { BizError } from '../../common/bizError'
import { originalPathOf } from '../galleryService'

// 一次最多带出几个文件
const MAX_FILES = 50
// 跟手的小图边长
const ICON_SIZE = 64

// 跟手的小图：用缩略图（webp 要先转成 PNG，nativeImage 不认 webp），没有就用应用图标
async function dragIcon(thumbsDir: string, hash: string | null): Promise<NativeImage> {
  const thumb = hash ? join(thumbsDir, `${hash}.webp`) : ''
  if (thumb && existsSync(thumb)) {
    try {
      const png = await sharp(thumb).resize(ICON_SIZE, ICON_SIZE, { fit: 'cover' }).png().toBuffer()
      return nativeImage.createFromBuffer(png)
    } catch {
      // 退回应用图标
    }
  }
  return nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png')).resize({ width: ICON_SIZE, height: ICON_SIZE })
}

// 从这个窗口开始一次原生拖拽，带出这些文件位置的原图（目录找不到、文件不见了的跳过）
export async function startNativeDrag(sender: WebContents, thumbsDir: string, rawIds: unknown, hash: unknown): Promise<number> {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((id) => !Number.isInteger(id))) {
    throw new BizError('BAD_REQUEST', '要拖的图不对')
  }
  const files: string[] = []
  for (const id of (rawIds as number[]).slice(0, MAX_FILES)) {
    const path = await originalPathOf(id)
    if (path && await stat(path).then((info) => info.isFile(), () => false)) {
      files.push(path)
    }
  }
  if (files.length === 0) {
    throw new BizError('DEPENDENCY_FAILED', '原图暂时打不开，拖不出去')
  }
  const icon = await dragIcon(thumbsDir, typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash) ? hash : null)
  sender.startDrag({ file: files[0], files, icon })
  return files.length
}
