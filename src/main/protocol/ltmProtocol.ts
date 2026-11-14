import { net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 自定义协议名：渲染进程通过 ltm://thumb/{hash}.webp 加载缩略图，不经 IPC 传图片数据
export const LTM_SCHEME = 'ltm'

// 缩略图文件名只允许 sha256 十六进制加 .webp，防止路径穿越
const THUMB_NAME = /^[0-9a-f]{64}\.webp$/

// 必须在 app ready 之前调用
export function registerLtmSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: LTM_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

// app ready 之后注册处理器
export function handleLtmProtocol(thumbsDir: string): void {
  protocol.handle(LTM_SCHEME, (request) => {
    const url = new URL(request.url)
    const name = url.pathname.replace(/^\//, '')
    if (url.host === 'thumb' && THUMB_NAME.test(name)) {
      return net.fetch(pathToFileURL(join(thumbsDir, name)).toString())
    }
    return new Response('Not Found', { status: 404 })
  })
}
