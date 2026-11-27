import { BAILIAN_CONFIG } from '../../../../config/cloudConfig'
import { searchCall } from '../../bailianClient'
import { defineTool, isToolError, parseToolJson, truncateLabel } from '../toolRegistry'

const WEB_SEARCH_FILTER_PROMPT =
  '你是精准的联网搜索过滤助手。基于联网检索结果，剔除广告、营销号和无关噪音，只保留与问题直接相关、可靠且最新的核心事实；用简洁中文要点输出（不超过 350 字），不确定的地方如实注明，绝不编造。'

function formatWebSearchStart(args: Record<string, unknown>): string {
  const q = truncateLabel(args.query, 18)
  return q ? `联网搜索：${q}` : '联网搜索'
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description: '联网搜索实时资料、新闻、动漫角色/作品/画师设定或本地图库以外的知识。传入简洁精准的搜索关键词。',
  sideEffect: 'read',
  formatStart: formatWebSearchStart,
  formatDone(args, result) {
    const start = formatWebSearchStart(args)
    const parsed = parseToolJson(result.content) as Record<string, unknown> | null
    if (isToolError(parsed)) return `${start} · 暂不可用`
    const sources = Array.isArray(parsed?.sources) ? parsed.sources.length : 0
    return sources > 0 ? `${start} · ${sources} 条来源` : `${start} · 已整理`
  },
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: '简洁精准的搜索词（中英文皆可）' }
    }
  },
  async execute(args, env) {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 120) : ''
    if (!query) {
      return { content: JSON.stringify({ error: '缺少搜索关键词 query' }), outcome: { type: 'none' } }
    }
    try {
      const res = await searchCall({
        kind: 'chat',
        model: BAILIAN_CONFIG.chatModel,
        search: true,
        enableThinking: false,
        timeoutMs: 35_000,
        signal: env.signal,
        instructions: WEB_SEARCH_FILTER_PROMPT,
        text: query
      })
      return {
        content: JSON.stringify({
          query,
          summary: res.text.trim(),
          sources: res.sources.slice(0, 5)
        }),
        outcome: { type: 'none' }
      }
    } catch (err) {
      if (env.signal?.aborted) throw err
      return {
        content: JSON.stringify({ error: '联网搜索暂时不可用，请基于已有知识如实说明无法联网核实。' }),
        outcome: { type: 'none' }
      }
    }
  }
})
