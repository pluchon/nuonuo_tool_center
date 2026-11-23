import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { aiSearchCache } from '../db/schema'
import { getLogger } from '../common/logger'

export const SEARCH_CACHE_TTL = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 1000
const log = getLogger('search-cache')
const pending = new WeakMap<object, Map<string, Promise<unknown>>>()

export function searchCacheKey(kind: string, input: unknown): string {
  return kind + ':' + createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export async function readSearchCache<T>(key: string): Promise<T | undefined> {
  try {
    const [row] = await getDatabase().db.select({ value: aiSearchCache.value }).from(aiSearchCache)
      .where(and(eq(aiSearchCache.key, key), gt(aiSearchCache.expiresAt, new Date())))
    return row?.value as T | undefined
  } catch (error) {
    log.warn('读取检索缓存失败', error)
    return undefined
  }
}

export async function writeSearchCache(key: string, value: unknown): Promise<void> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SEARCH_CACHE_TTL)
  await getDatabase().db.transaction(async (tx) => {
    await tx.delete(aiSearchCache).where(lt(aiSearchCache.expiresAt, now))
    await tx.insert(aiSearchCache).values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: aiSearchCache.key, set: { value, expiresAt } })
    const oldest = tx.select({ key: aiSearchCache.key }).from(aiSearchCache)
      .orderBy(desc(aiSearchCache.expiresAt), aiSearchCache.key).offset(MAX_ENTRIES)
    await tx.delete(aiSearchCache).where(inArray(aiSearchCache.key, oldest))
  }).catch((error: unknown) => log.warn('写入检索缓存失败', error))
}

// 并发请求共用一次计算。失败或降级结果不写入缓存，下次查询仍可重试。
export function cachedSearchValue<T>(key: string, validate: (value: unknown) => value is T, load: () => Promise<T | undefined>): Promise<T | undefined> {
  const db = getDatabase()
  const active = pending.get(db) ?? new Map<string, Promise<unknown>>()
  pending.set(db, active)
  const existing = active.get(key)
  if (existing) return existing as Promise<T | undefined>
  const task = (async () => {
    const cached = await readSearchCache(key)
    if (validate(cached)) return cached
    const value = await load()
    if (value !== undefined) await writeSearchCache(key, value)
    return value
  })().finally(() => active.delete(key))
  active.set(key, task)
  return task
}
