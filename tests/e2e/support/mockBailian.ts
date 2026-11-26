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
    const usage = { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19, prompt_tokens_details: { cached_tokens: 9 } }
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
        stream?: boolean
        input?: { contents?: Array<{ image?: string }> }
        tools?: unknown[]
        messages?: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>
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
          const userPrompt = typeof last?.content === 'string' ? last.content : ''
          const args = userPrompt.includes('猫')
            ? { tags: ['猫'], contrast: [] }
            : { tags: ['风景'], orientation: 'landscape', contrast: [] }
          message = {
            role,
            content: null,
            tool_calls: [{
              id: 'fixture-search', type: 'function',
              function: { name: 'search_images', arguments: JSON.stringify(args) }
            }]
          }
        } else if (Array.isArray(last?.content) && last.content.some(part => part.type === 'text' && part.text?.includes('用蓝调夜景做标签'))) {
          message = { role, content: jsonBlock({ tags: ['蓝调夜景'] }) }
        } else if (typeof last?.content === 'string' && last.content.includes('"folders"')) {
          message = { role, content: jsonBlock({ folders: [{ name: '表情包', tags: ['表情包'] }] }) }
        } else {
          message = { role, content: '找到了几张合适的图片。' }
        }
        if (body.stream) {
          const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
          const chunks: string[] = []
          if (message.tool_calls?.length) {
            const tc = message.tool_calls[0] as { id: string; type: 'function'; function: { name: string; arguments: string } }
            chunks.push(
              sse({
                id: 'chat-fixture',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { role, tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }]
              }),
              sse({
                id: 'chat-fixture',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tc.function.arguments } }] }, finish_reason: null }]
              }),
              sse({ id: 'chat-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            )
          } else {
            const text = message.content ?? ''
            const mid = Math.ceil(text.length / 2)
            const parts = mid > 0 ? [text.slice(0, mid), text.slice(mid)].filter(Boolean) : ['']
            parts.forEach((part, idx) => {
              chunks.push(
                sse({
                  id: 'chat-fixture',
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: idx === 0 ? { role, content: part } : { content: part }, finish_reason: null }]
                })
              )
            })
            chunks.push(sse({ id: 'chat-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
          }
          chunks.push(sse({ id: 'chat-fixture', object: 'chat.completion.chunk', choices: [], usage }), 'data: [DONE]\n\n')
          return new Response(chunks.join(''), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
          })
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
