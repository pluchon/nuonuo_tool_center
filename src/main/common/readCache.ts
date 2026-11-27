import type { GalleryListVO, LibraryOverviewVO } from '@shared/api'

export const GALLERY_CACHE_MAX_ENTRIES = 8
export const OVERVIEW_CACHE_TTL_MS = 2000

export interface ReadCacheOptions {
  bypassVitest?: boolean
  now?: number
}

let libraryVersion = 1
const galleryCache = new Map<string, GalleryListVO>()
let overviewCache: { version: number; cachedAt: number; value: LibraryOverviewVO } | null = null
const dictionaryCache = new Map<'category' | 'organized', unknown>()

function isDisabled(options?: ReadCacheOptions): boolean {
  return Boolean(process.env.VITEST) && !options?.bypassVitest
}

/** 构造键顺序无关的稳定查询键。 */
export function stableQueryKey(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableQueryKey(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableQueryKey(v)}`).join(',')}}`
}

/** 返回当前图库版本号，用于校验只读缓存是否仍与数据库写入同步。 */
export function getLibraryVersion(): number {
  return libraryVersion
}

/** 写入发生后递增图库版本号并清空所有只读缓存。 */
export function bumpLibraryVersion(): number {
  libraryVersion += 1
  galleryCache.clear()
  overviewCache = null
  dictionaryCache.clear()
  return libraryVersion
}

function galleryEntryKey(key: string): string {
  return `${libraryVersion}:${key}`
}

/** 读取图库列表只读缓存；命中时将条目刷新到 LRU 队尾。 */
export function getCachedGallery(key: string, options?: ReadCacheOptions): GalleryListVO | undefined {
  if (isDisabled(options)) return undefined
  const fullKey = galleryEntryKey(key)
  const hit = galleryCache.get(fullKey)
  if (!hit) return undefined
  galleryCache.delete(fullKey)
  galleryCache.set(fullKey, hit)
  return hit
}

/** 写入图库列表只读缓存（最多保留 8 条，按 LRU 淘汰）。 */
export function setCachedGallery(key: string, value: GalleryListVO, options?: ReadCacheOptions): void {
  if (isDisabled(options)) return
  const fullKey = galleryEntryKey(key)
  if (galleryCache.has(fullKey)) {
    galleryCache.delete(fullKey)
  } else if (galleryCache.size >= GALLERY_CACHE_MAX_ENTRIES) {
    const oldestKey = galleryCache.keys().next().value
    if (oldestKey !== undefined) {
      galleryCache.delete(oldestKey)
    }
  }
  galleryCache.set(fullKey, value)
}

/** 读取侧栏概况只读缓存（随版本和 2 秒离线根目录检查 TTL 自动失效）。 */
export function getCachedOverview(options?: ReadCacheOptions): LibraryOverviewVO | undefined {
  if (isDisabled(options) || !overviewCache) return undefined
  const now = options?.now ?? Date.now()
  if (overviewCache.version !== libraryVersion || now - overviewCache.cachedAt >= OVERVIEW_CACHE_TTL_MS) {
    overviewCache = null
    return undefined
  }
  return overviewCache.value
}

/** 写入侧栏概况只读缓存。 */
export function setCachedOverview(value: LibraryOverviewVO, options?: ReadCacheOptions): void {
  if (isDisabled(options)) return
  overviewCache = {
    version: libraryVersion,
    cachedAt: options?.now ?? Date.now(),
    value
  }
}

/** 读取版本化检索词典缓存。 */
export function getCachedDictionary<T>(includeOrganized: boolean, options?: ReadCacheOptions): T | undefined {
  if (isDisabled(options)) return undefined
  return dictionaryCache.get(includeOrganized ? 'organized' : 'category') as T | undefined
}

/** 写入版本化检索词典缓存。 */
export function setCachedDictionary<T>(includeOrganized: boolean, value: T, options?: ReadCacheOptions): void {
  if (isDisabled(options)) return
  dictionaryCache.set(includeOrganized ? 'organized' : 'category', value)
}
