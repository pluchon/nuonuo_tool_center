// 其他 AI 回复的解析：找出 json 代码块（没有代码块时退而找第一个完整的 { … }），数一下有几条能用的内容

// 解析出对象；找不到或不是对象返回 null
export function parseAssistJson(text: string): Record<string, unknown> | null {
  if (!text.trim()) {
    return null
  }
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (block) {
    const v = tryParse(block[1].trim())
    if (v) {
      return v
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : null
}

// 有几条：名字、角色、作品、出处各算一条，每个标签算一条（描述不算）
export function countAssistFields(o: Record<string, unknown>): number {
  const str = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
  const tags = Array.isArray(o.tags) ? o.tags.filter(str).length : 0
  return [o.name, o.character, o.work, o.source].filter(str).length + tags
}
