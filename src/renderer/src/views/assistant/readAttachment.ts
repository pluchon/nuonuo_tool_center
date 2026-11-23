import { AI_MARKDOWN_MAX_BYTES, type AiAttachment } from '@shared/api'

// Windows 的 Markdown 文件可能没有 MIME 类型，按扩展名识别后校验实际文本。
export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown)$/i.test(name)
}

export async function readAttachment(file: Blob, name: string): Promise<AiAttachment> {
  if (isMarkdownFile(name)) {
    if (file.size > AI_MARKDOWN_MAX_BYTES) throw new Error(`Markdown 文件不能超过 ${AI_MARKDOWN_MAX_BYTES / 1024} KiB`)
    const bytes = await file.arrayBuffer()
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('Markdown 文件需要使用 UTF-8 编码')
    }
    if (!text.trim()) throw new Error('Markdown 文件为空')
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('Markdown 文件含有无效控制字符')
    return { kind: 'markdown', name, text }
  }
  if (!file.type.startsWith('image/')) throw new Error('请选择图片或 Markdown 文件')
  if (!file.size) throw new Error('图片文件为空')
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reader.onabort = () => reject(new Error('读不到图片文件'))
    reader.readAsDataURL(file)
  })
  return { kind: 'image', name, mimeType: file.type, dataUrl }
}

export async function readClipboardImage(): Promise<AiAttachment> {
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((value) => value.startsWith('image/'))
    if (type) return readAttachment(await item.getType(type), '')
  }
  throw new Error('剪贴板里没有图片')
}
