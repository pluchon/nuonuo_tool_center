import OpenAI from 'openai'
import { BAILIAN_CONFIG, readCloudCredentials } from '../../config/cloudConfig'

// 以图搜图识别结果（模型按约定输出的 JSON）；出处不让模型写，只采用工具返回的 searchHits
export interface ImageIdentifyResult {
  characters: Array<{ nameZh: string; nameEn?: string; series?: string; confidence: number }>
  artist?: string
  description: string
  ocrText: string
  suggestedName: string
  tagsZh: string[]
}

// 一次识别调用的原始信息，便于落库与排查
export interface ImageIdentifyResponse {
  model: string
  parsed: ImageIdentifyResult | null
  rawText: string
  searchCalls: number
  searchHits: Array<{ title?: string; url?: string }>
  usage: unknown
  latencyMs: number
}

const IDENTIFY_PROMPT = `你是二次元图片鉴定助手。用以图搜图工具检索这张图，只检索一次，再结合检索结果回答。
只输出一个 JSON 对象，不要输出其他文字，字段：
{"characters":[{"nameZh":"角色中文名","nameEn":"英文或罗马音","series":"出自作品","confidence":0到1}],
 "artist":"检索结果中能确认的画师名，不能确认则省略",
 "description":"一句话中文画面描述",
 "ocrText":"图中文字逐字转写，没有则为空字符串",
 "suggestedName":"适合当文件名的简短中文名，不含扩展名",
 "tagsZh":["5到10个中文标签"]}
认不出的角色不要编造，characters 留空。不要输出任何链接。`

let client: OpenAI | null = null

// 懒加载百炼兼容客户端
function getClient(): OpenAI {
  if (client) {
    return client
  }
  const { dashscopeApiKey } = readCloudCredentials()
  if (!dashscopeApiKey) {
    throw new Error('缺少环境变量 DASHSCOPE_API_KEY')
  }
  // 以图搜图服务端耗时可达 2 分钟以上；关闭自动重试，避免一次超时被重试成多次计费
  client = new OpenAI({
    apiKey: dashscopeApiKey,
    baseURL: BAILIAN_CONFIG.baseURL,
    timeout: BAILIAN_CONFIG.requestTimeoutMs,
    maxRetries: 0
  })
  return client
}

// 从模型文本里取出 JSON 对象；解析失败返回 null，由调用方决定如何处理
function extractJson(text: string): ImageIdentifyResult | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as ImageIdentifyResult
  } catch {
    return null
  }
}

// 解析 image_search_call 的输出（JSON 字符串，内含 title/url 列表）
function collectSearchHits(output: unknown[]): { calls: number; hits: Array<{ title?: string; url?: string }> } {
  let calls = 0
  const hits: Array<{ title?: string; url?: string }> = []
  for (const item of output as Array<Record<string, unknown>>) {
    if (item.type !== 'image_search_call') {
      continue
    }
    calls++
    const raw = item.output
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      const list = Array.isArray(parsed) ? parsed : ((parsed as { results?: unknown[] })?.results ?? [])
      for (const r of list as Array<Record<string, unknown>>) {
        hits.push({ title: r.title as string | undefined, url: r.url as string | undefined })
      }
    } catch {
      // 输出格式不认识时只计次数，原始响应仍由调用方保留
    }
  }
  return { calls, hits }
}

// 用以图搜图工具识别一张图（图片须是云端可访问的 URL）
export async function identifyImage(imageUrl: string, model: string = BAILIAN_CONFIG.visionSearchModel): Promise<ImageIdentifyResponse> {
  const t0 = Date.now()
  const request = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: imageUrl },
          { type: 'input_text', text: IDENTIFY_PROMPT }
        ]
      }
    ],
    tools: [{ type: 'image_search' }]
  }
  const res = (await getClient().responses.create(request as never)) as unknown as {
    output: unknown[]
    output_text?: string
    usage?: unknown
  }
  const rawText = res.output_text ?? ''
  const { calls, hits } = collectSearchHits(res.output ?? [])
  return {
    model,
    parsed: extractJson(rawText),
    rawText,
    searchCalls: calls,
    searchHits: hits,
    usage: res.usage,
    latencyMs: Date.now() - t0
  }
}
