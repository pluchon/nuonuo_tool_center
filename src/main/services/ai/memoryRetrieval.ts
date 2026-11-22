// 按这句话找最相关的几条记忆（第④层）：向量还没上线时按相邻两字的重合度打分，再乘可信度
import { findValidMemories, type AiMemoryEntity } from '../../repositories/aiMemoryRepository'

// 一次最多带几条
const TOP = 5

// 相邻两字切词（中文按字，英文按小写）
function bigrams(s: string): Set<string> {
  const chars = Array.from(s.toLowerCase().replace(/\s+/g, ''))
  const out = new Set<string>()
  for (let i = 0; i < chars.length - 1; i++) {
    out.add(chars[i] + chars[i + 1])
  }
  return out
}

// 和这句话最相关的记忆；明说的偏好（preference）即使不相关也优先带上几条
export async function relevantMemories(question: string): Promise<AiMemoryEntity[]> {
  const all = await findValidMemories()
  const q = bigrams(question)
  const scored = all.map((m) => {
    const mb = bigrams(m.content)
    let hit = 0
    for (const g of mb) {
      if (q.has(g)) {
        hit++
      }
    }
    const overlap = mb.size > 0 ? hit / mb.size : 0
    return { m, score: (overlap + (m.kind === 'preference' ? 0.2 : 0)) * m.confidence }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP)
    .map((s) => s.m)
}
