import type { ElectronApplication } from 'playwright'
import { launchApp, type CaseDirs } from './app'

// 从 Electron 主进程截获请求，保留 SDK、鉴权、响应解析和记账的真实执行路径。
export async function launchWithMockBailian(dirs: CaseDirs, rejectedImages = 0) {
  const desktop = await launchApp(dirs)
  await desktop.app.evaluate(({ nativeImage }, toReject) => {
    const apiKey = 'fixture-bailian-api-key'
    const requests: string[] = []
    const main = globalThis as typeof globalThis & { bailianFixtureRequests?: string[] }
    main.bailianFixtureRequests = requests
    const usage = { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 }
    const jsonBlock = (value: object): string => '```json\n' + JSON.stringify(value) + '\n```'
    let remainingRejections = toReject
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname !== 'dashscope.aliyuncs.com' || request.headers.get('authorization') !== `Bearer ${apiKey}`) {
        throw new Error(`离线测试拒绝请求：${request.method} ${url.hostname}${url.pathname}`)
      }
      requests.push(url.pathname.split('/').at(-1)!)
      const body = await request.json() as {
        input?: { contents?: Array<{ image?: string }> }
        tools?: unknown[]
        messages?: Array<{ role: string; content?: string }>
      }

      if (url.pathname.endsWith('/responses')) {
        if (remainingRejections > 0) {
          remainingRejections--
          return Response.json({ error: { code: 'DataInspectionFailed', message: 'The input image failed the content inspection.' } }, { status: 400 })
        }
        const text = jsonBlock({ name: '示例图片', tags: ['风景', '表情包'], description: '合成测试图片。' })
        return Response.json({
          id: 'response-fixture',
          object: 'response',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
          usage: { input_tokens: 15, output_tokens: 4 }
        })
      }

      if (url.pathname.endsWith('/multimodal-embedding')) {
        const image = body.input?.contents?.[0]?.image
        const sample = image ? nativeImage.createFromDataURL(image).resize({ width: 1, height: 1 }).getBitmap() : null
        // 合成的草地和夜空亮度差异明显，不依赖请求先后顺序。
        const index = sample && sample[1] < 100 ? 1 : 0
        const embedding = Array.from({ length: 1024 }, (_, i) => Number(i === index))
        return Response.json({ output: { embeddings: [{ embedding }] }, usage: { input_tokens: 0, image_tokens: 4 } })
      }

      if (url.pathname.endsWith('/chat/completions')) {
        const last = body.messages?.at(-1)
        const role = 'assistant'
        let message: { role: string; content: string | null; tool_calls?: unknown[] }
        if (body.tools?.length && last?.role !== 'tool') {
          message = {
            role,
            content: null,
            tool_calls: [{
              id: 'fixture-search', type: 'function',
              function: { name: 'search_images', arguments: JSON.stringify({ tags: ['风景'], orientation: 'landscape' }) }
            }]
          }
        } else if (last?.content?.includes('"folders"')) {
          message = { role, content: jsonBlock({ folders: [{ name: '表情包', tags: ['表情包'] }] }) }
        } else {
          message = { role, content: '找到了几张合适的图片。' }
        }
        return Response.json({ id: 'chat-fixture', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage })
      }

      throw new Error(`离线测试缺少响应：${request.method} ${url.pathname}`)
    }
    // 先装好拦截，再让主进程看到模拟密钥。
    process.env.DASHSCOPE_API_KEY = apiKey
  }, rejectedImages)
  return desktop
}

export async function bailianRequests(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as typeof globalThis & { bailianFixtureRequests?: string[] }).bailianFixtureRequests ?? [])
}
