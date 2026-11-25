// 按这句话找最相关的几条记忆（第④层）：有向量时用 pgvector 余弦相似度与字面重合度加权，否则按相邻两字重合度降级
import { findMemorySimilarities, findValidMemories, type AiMemoryEntity } from '../../repositories/aiMemoryRepository'
import { queryVector } from './embeddingService'

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
  const hasEmbeddings = all.some((m) => Array.isArray(m.embedding) && m.embedding.length > 0)
  let sims = new Map<number, number>()
  if (hasEmbeddings) {
    const qVec = await queryVector(question).catch(() => null)
    if (qVec) {
      sims = await findMemorySimilarities(qVec).catch(() => new Map<number, number>())
    }
  }
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
    const vecSim = sims.get(m.id)
    const hasVecSim = vecSim !== undefined && Number.isFinite(vecSim)
    const base = hasVecSim ? 0.65 * Math.max(0, vecSim) + 0.35 * overlap : overlap
    return { m, score: (base + (m.kind === 'preference' ? 0.2 : 0)) * m.confidence }
  })
  // 旧记录可能重复。相同内容只附带一次，取可信度和关联度最高的那条。
  const selected = new Map<string, AiMemoryEntity>()
  for (const { m, score } of scored.sort((a, b) => b.score - a.score)) {
    if (score <= 0 || selected.size >= TOP) break
    if (!selected.has(m.content)) selected.set(m.content, m)
  }
  return [...selected.values()]
}
