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

// 按文件 id 找原图的绝对路径（不在图库里返回 null）
export type OriginalResolver = (fileId: number) => Promise<string | null>

// 必须在 app ready 之前调用
export function registerLtmSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: LTM_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

// app ready 之后注册处理器
export function handleLtmProtocol(thumbsDir: string, backgroundsDir: string, resolveOriginal: OriginalResolver): void {
  protocol.handle(LTM_SCHEME, async (request) => {
    const url = new URL(request.url)
    const name = url.pathname.replace(/^\//, '')
    // 缩略图：先确认文件在（被手动删掉时 net.fetch 会一直挂着），在就照常流式给，不在马上回 404
    if (url.host === 'thumb' && THUMB_NAME.test(name)) {
      const file = join(thumbsDir, name)
      const isFile = await stat(file).then((s) => s.isFile(), () => false)
      if (isFile) return net.fetch(pathToFileURL(file).toString()).catch(() => new Response('Not Found', { status: 404 }))
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
