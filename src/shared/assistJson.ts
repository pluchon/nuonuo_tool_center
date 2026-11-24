// 优先读取外部 AI 回复中的 JSON 代码块，也接受正文里的 JSON 对象。

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

// 空模板也按标准格式在本地处理；自定义字段的 JSON 仍可交给模型识别。
export function isAssistRecord(o: Record<string, unknown>): boolean {
  return Object.keys(o).length === 0 || Array.isArray(o.tags) ||
    ['name', 'description', 'character', 'work', 'source'].some(key => typeof o[key] === 'string')
}
