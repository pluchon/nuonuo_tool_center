import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm'
import { getDatabase, type DatabaseHandle } from '../db/client'
import { aiSearchCache } from '../db/schema'
import { getLogger } from '../common/logger'

export const SEARCH_CACHE_TTL = 24 * 60 * 60 * 1000
export async function recordLocalReuse(owner = getDatabase()): Promise<void> {
  if (owner.pg.closed) return
  await owner.pg.query(`insert into app_setting(key,value) values ('ai.localHits','1'::jsonb)
    on conflict (key) where delete_state=0 do update set value=to_jsonb((app_setting.value #>> '{}')::bigint+1)`)
    .catch((err:unknown) => log.warn('本地缓存计数更新失败', err))
}
const MAX_ENTRIES = 1000
const log = getLogger('search-cache')
const pending = new WeakMap<DatabaseHandle, Map<string, Promise<unknown>>>()

export function searchCacheKey(kind: string, input: unknown): string {
  return kind + ':' + createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

async function readSearchCache(owner: DatabaseHandle, key: string): Promise<unknown> {
  try {
    const [row] = await owner.db.select({ value: aiSearchCache.value }).from(aiSearchCache)
      .where(and(eq(aiSearchCache.key, key), gt(aiSearchCache.expiresAt, new Date())))
    return row?.value
  } catch (error) {
    log.warn('读取检索缓存失败', error)
    return undefined
  }
}

async function writeSearchCache(owner: DatabaseHandle, key: string, value: unknown): Promise<void> {
  if (owner.pg.closed) return
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SEARCH_CACHE_TTL)
  await owner.db.transaction(async (tx) => {
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
  if (existing) return existing.then(async (value) => {
    if (!validate(value)) return undefined
    await recordLocalReuse(db)
    return value
  })
  const task = (async () => {
    const cached = await readSearchCache(db, key)
    if (validate(cached)) {
      await recordLocalReuse(db)
      return cached
    }
    const value = await load()
    if (value === undefined || !validate(value)) return undefined
    await writeSearchCache(db, key, value)
    return value
  })().finally(() => active.delete(key))
  active.set(key, task)
  return task
}
