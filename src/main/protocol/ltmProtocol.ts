import { net, protocol } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CUSTOM_BACKGROUND_NAME } from '@shared/settings'

// 自定义协议名：渲染进程通过 ltm://thumb/{hash}.webp 加载缩略图、ltm://file/{fileId} 加载原图、ltm://bg/{名字} 加载自定义背景，不经 IPC 传图片数据
export const LTM_SCHEME = 'ltm'

// 缩略图文件名只允许 sha256 十六进制加 .webp，防止路径穿越
const THUMB_NAME = /^[0-9a-f]{64}\.webp$/
// 原图只认图库里的文件 id，不接受路径
const FILE_ID = /^[1-9][0-9]{0,15}$/

// 缩略图内存 LRU 缓存上限：单文件不超过 256 KiB，总容量 16 MiB，最多 400 条
export const THUMB_CACHE_MAX_BYTES = 16 * 1024 * 1024
export const THUMB_CACHE_MAX_ENTRIES = 400
export const THUMB_CACHE_MAX_SINGLE_BYTES = 256 * 1024

const THUMB_RESPONSE_HEADERS = {
  'Content-Type': 'image/webp',
  'Cache-Control': 'public, max-age=31536000, immutable'
} as const

export type ThumbReader = (filePath: string) => Promise<Uint8Array>

const thumbCache = new Map<string, Uint8Array>()
let thumbCacheBytes = 0

function createCachedThumbResponse(buf: Uint8Array): Response {
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: THUMB_RESPONSE_HEADERS
  })
}

function setThumbCache(name: string, bytes: Uint8Array): void {
  if (bytes.byteLength > THUMB_CACHE_MAX_SINGLE_BYTES) {
    return
  }
  const existing = thumbCache.get(name)
  if (existing) {
    thumbCacheBytes -= existing.byteLength
    thumbCache.delete(name)
  }
  const copy = new Uint8Array(bytes)
  thumbCache.set(name, copy)
  thumbCacheBytes += copy.byteLength
  while (thumbCacheBytes > THUMB_CACHE_MAX_BYTES || thumbCache.size > THUMB_CACHE_MAX_ENTRIES) {
    const oldest = thumbCache.keys().next()
    if (oldest.done) break
    const evicted = thumbCache.get(oldest.value)
    thumbCache.delete(oldest.value)
    if (evicted) thumbCacheBytes -= evicted.byteLength
  }
}

export function clearThumbProtocolCache(): void {
  thumbCache.clear()
  thumbCacheBytes = 0
}

export async function handleThumbRequest(
  thumbsDir: string,
  name: string,
  reader: ThumbReader = (filePath) => readFile(filePath)
): Promise<Response> {
  if (!THUMB_NAME.test(name)) {
    return new Response('Not Found', { status: 404 })
  }
  const hit = thumbCache.get(name)
  if (hit) {
    thumbCache.delete(name)
    thumbCache.set(name, hit)
    return createCachedThumbResponse(hit)
  }
  let bytes: Uint8Array
  try {
    bytes = await reader(join(thumbsDir, name))
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  setThumbCache(name, bytes)
  return createCachedThumbResponse(bytes)
}

// 按文件 id 找原图的绝对路径（不在图库里返回 null）
export type OriginalResolver = (fileId: number) => Promise<string | null>

// 必须在 app ready 之前调用
export function registerLtmSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: LTM_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

// 缩略图内容按内容哈希寻址，长期不变，补齐强缓存与默认 MIME 头
export function buildThumbResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'image/webp')
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  })
}

// app ready 之后注册处理器
export function handleLtmProtocol(thumbsDir: string, backgroundsDir: string, resolveOriginal: OriginalResolver): void {
  protocol.handle(LTM_SCHEME, async (request) => {
    const url = new URL(request.url)
    const name = url.pathname.replace(/^\//, '')
    // 缩略图：优先命中内存 LRU，未命中时单次 readFile 读取并回填缓存，缺失立即返回 404
    if (url.host === 'thumb') {
      return handleThumbRequest(thumbsDir, name)
    }
    // 自定义背景图：只认应用自己生成的文件名；整张读进内存再给（不留文件句柄，换图时旧图马上能删）
    if (url.host === 'bg' && CUSTOM_BACKGROUND_NAME.test(name)) {
      const bytes = await readFile(join(backgroundsDir, name)).catch(() => null)
      return bytes ? new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp' } }) : new Response('Not Found', { status: 404 })
    }
    if (url.host === 'file' && FILE_ID.test(name)) {
      // 文件不见了、目录离线时 net.fetch 会一直挂着，先确认文件在，读失败也回 404，界面才能退回缩略图
      const abs = await resolveOriginal(Number(name)).catch(() => null)
      const isFile = abs ? await stat(abs).then((s) => s.isFile(), () => false) : false
      if (abs && isFile) {
        return net.fetch(pathToFileURL(abs).toString()).catch(() => new Response('Not Found', { status: 404 }))
      }
    }
    return new Response('Not Found', { status: 404 })
  })
}
