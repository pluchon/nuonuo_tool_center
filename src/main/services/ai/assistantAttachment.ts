import { AI_IMAGE_MAX_BASE64, AI_MARKDOWN_MAX_BYTES, type AiAttachment } from '@shared/api'
import { BizError } from '../../common/bizError'
import { hashBuffer } from '../scan/imageProbe'
import { toDataUrl } from './imagePrep'

// 原文件的哈希仅保存在本机，重试或重新打开对话时据此核对图库的最新分级。
export type StoredAttachment = Extract<AiAttachment, { kind: 'markdown' }>
  | (Extract<AiAttachment, { kind: 'image' }> & { originalHash?: string })

// 消息中只保存文件名，绝对路径、控制字符不应进入对话记录。
function checkName(name: unknown): string {
  if (typeof name !== 'string' || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name)) {
    throw new BizError('BAD_REQUEST', '附件名称无效')
  }
  return name
}

async function imageAttachment(raw: unknown, name: string, mimeType?: unknown): Promise<StoredAttachment> {
  const match = typeof raw === 'string' && raw.length <= AI_IMAGE_MAX_BASE64 + 100
    ? /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(raw)
    : null
  if (!match || match[2].length > AI_IMAGE_MAX_BASE64) {
    throw new BizError('BAD_REQUEST', '图片不对或太大（最多 20 MB）')
  }
  const type = match[1].toLowerCase()
  if (mimeType !== undefined && (typeof mimeType !== 'string' || mimeType.toLowerCase() !== type)) {
    throw new BizError('BAD_REQUEST', '图片类型与附件内容不一致')
  }
  try {
    const bytes = Buffer.from(match[2], 'base64')
    const dataUrl = await toDataUrl(bytes, 512)
    return { kind: 'image', name, mimeType: type, dataUrl, originalHash: hashBuffer(bytes) }
  } catch {
    throw new BizError('BAD_REQUEST', '这张图读不出来')
  }
}

async function checkAttachment(raw: unknown): Promise<StoredAttachment> {
  if (!raw || typeof raw !== 'object') throw new BizError('BAD_REQUEST', '附件格式无效')
  const file = raw as Record<string, unknown>
  const name = checkName(file.name)
  if (file.kind === 'image') return imageAttachment(file.dataUrl, name, file.mimeType)
  if (file.kind !== 'markdown' || !/\.(md|markdown)$/i.test(name)) throw new BizError('BAD_REQUEST', '请选择图片或 Markdown 文件')
  if (typeof file.text !== 'string' || Buffer.byteLength(file.text, 'utf8') > AI_MARKDOWN_MAX_BYTES) {
    throw new BizError('BAD_REQUEST', 'Markdown 文件最多 64 KiB')
  }
  const text = file.text.replace(/^\uFEFF/, '')
  if (!text.trim()) throw new BizError('BAD_REQUEST', 'Markdown 文件内容为空')
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || Buffer.from(text, 'utf8').toString('utf8') !== text) {
    throw new BizError('BAD_REQUEST', 'Markdown 文件需要使用 UTF-8 文本')
  }
  return { kind: 'markdown', name, text }
}

export async function checkAttachments(files: unknown, single: unknown, legacyImage: unknown): Promise<StoredAttachment[]> {
  if (files == null) {
    if (single == null) return legacyImage == null ? [] : [await imageAttachment(legacyImage, '')]
    if (legacyImage == null) return [await checkAttachment(single)]
  } else if (Array.isArray(files) && files.length <= 2 && single == null && legacyImage == null) {
    if (new Set(files.map((file) => file?.kind)).size !== files.length) {
      throw new BizError('BAD_REQUEST', '一条消息最多添加一张图片和一个 Markdown 文件')
    }
    return Promise.all(files.map(checkAttachment))
  }
  throw new BizError('BAD_REQUEST', '附件格式无效')
}
