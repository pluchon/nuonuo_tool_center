import { EMBEDDING_CONFIG } from '../../config/cloudConfig'

// pgvector 使用单精度浮点数；零向量无法计算余弦相似度。
export function isEmbeddingVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === EMBEDDING_CONFIG.dimension
    && value.every(n => typeof n === 'number' && Number.isFinite(Math.fround(n)))
    && value.some(n => Math.fround(n) !== 0)
}
