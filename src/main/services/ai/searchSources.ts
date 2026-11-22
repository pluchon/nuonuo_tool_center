// 从 Responses 的输出里取联网搜索返回的来源链接；出处只采用这里的链接，不采用模型正文里自己写的

// 一个来源
export interface SearchSource {
  url: string
}

// 只接受 http 和 https 链接
function isWebUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// 收集 web_search_call.action.sources 里的链接，按出现顺序去重
export function collectSearchSources(output: unknown): SearchSource[] {
  const seen = new Set<string>()
  const out: SearchSource[] = []
  if (!Array.isArray(output)) {
    return out
  }
  for (const item of output as Array<Record<string, unknown>>) {
    if (item?.type !== 'web_search_call') {
      continue
    }
    const action = item.action as { sources?: Array<{ url?: unknown }> } | undefined
    for (const s of action?.sources ?? []) {
      const url = typeof s?.url === 'string' ? s.url : ''
      if (url && isWebUrl(url) && !seen.has(url)) {
        seen.add(url)
        out.push({ url })
      }
    }
  }
  return out
}

// 模型给出的出处只有出现在搜索来源里才保留，其余丢掉
export function keepToolSources(candidates: string[], sources: SearchSource[]): string[] {
  const allowed = new Set(sources.map((s) => s.url))
  return candidates.filter((c) => allowed.has(c))
}
