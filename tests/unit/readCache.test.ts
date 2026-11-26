import { beforeEach, describe, expect, it } from 'vitest'
import type { GalleryListVO, LibraryOverviewVO } from '../../src/shared/api'
import {
  GALLERY_CACHE_MAX_ENTRIES,
  OVERVIEW_CACHE_TTL_MS,
  bumpLibraryVersion,
  getCachedGallery,
  getCachedOverview,
  getLibraryVersion,
  setCachedGallery,
  setCachedOverview,
  stableQueryKey
} from '../../src/main/common/readCache'

function makeGallery(id: number): GalleryListVO {
  return {
    items: [
      {
        imageId: id,
        fileId: id,
        name: `img-${id}.jpg`,
        format: 'JPG',
        width: 100,
        height: 100,
        byteSize: 1024,
        hash: `hash-${id}`,
        thumb: 'READY',
        missing: false,
        offline: false,
        isR18: false,
        tagged: true,
        importedAt: '2026-11-26T00:00:00.000Z',
        takenAt: null
      }
    ]
  }
}

function makeOverview(total: number): LibraryOverviewVO {
  return {
    counts: { total, tagged: total, untagged: 0, recent: total, r18: 0, tags: 1, aiSuggest: 0 },
    sources: [],
    categories: [],
    lastScanAt: null
  }
}

beforeEach(() => {
  bumpLibraryVersion()
})

describe('readCache 版本化只读缓存', () => {
  it('Vitest 环境默认绕过自动缓存，显式 bypassVitest 后生效', () => {
    const key = stableQueryKey({ view: 'all', sort: 'new' })
    const val = makeGallery(1)
    setCachedGallery(key, val)
    expect(getCachedGallery(key)).toBeUndefined()

    setCachedGallery(key, val, { bypassVitest: true })
    expect(getCachedGallery(key)).toBeUndefined()
    expect(getCachedGallery(key, { bypassVitest: true })).toEqual(val)

    const ov = makeOverview(3)
    setCachedOverview(ov)
    expect(getCachedOverview()).toBeUndefined()

    setCachedOverview(ov, { bypassVitest: true, now: 1000 })
    expect(getCachedOverview({ bypassVitest: true, now: 1500 })).toEqual(ov)
  })

  it('stableQueryKey 对键顺序和 undefined 字段保持稳定', () => {
    const k1 = stableQueryKey({ view: 'all', sort: 'new', q: undefined, more: { fmt: ['JPG'], ori: ['h'] } })
    const k2 = stableQueryKey({ more: { ori: ['h'], fmt: ['JPG'] }, sort: 'new', view: 'all' })
    expect(k1).toBe(k2)
  })

  it('图库列表缓存支持 8 条 LRU 淘汰与命中刷新', () => {
    const opts = { bypassVitest: true }
    for (let i = 1; i <= GALLERY_CACHE_MAX_ENTRIES; i++) {
      setCachedGallery(`q-${i}`, makeGallery(i), opts)
    }
    // 命中 q-1，将其刷新为最近使用；随后写入 q-9 应淘汰最久未用的 q-2
    expect(getCachedGallery('q-1', opts)?.items[0].imageId).toBe(1)
    setCachedGallery('q-9', makeGallery(9), opts)

    expect(getCachedGallery('q-2', opts)).toBeUndefined()
    expect(getCachedGallery('q-1', opts)?.items[0].imageId).toBe(1)
    expect(getCachedGallery('q-9', opts)?.items[0].imageId).toBe(9)
  })

  it('bumpLibraryVersion 递增版本号并清空列表与概况缓存', () => {
    const opts = { bypassVitest: true, now: 10_000 }
    const v1 = getLibraryVersion()
    setCachedGallery('k1', makeGallery(1), opts)
    setCachedOverview(makeOverview(5), opts)

    expect(getCachedGallery('k1', opts)?.items[0].imageId).toBe(1)
    expect(getCachedOverview(opts)?.counts.total).toBe(5)

    const v2 = bumpLibraryVersion()
    expect(v2).toBe(v1 + 1)
    expect(getLibraryVersion()).toBe(v2)
    expect(getCachedGallery('k1', opts)).toBeUndefined()
    expect(getCachedOverview(opts)).toBeUndefined()
  })

  it('侧栏概况缓存按 2 秒 TTL 过期', () => {
    const t0 = 50_000
    setCachedOverview(makeOverview(8), { bypassVitest: true, now: t0 })

    expect(getCachedOverview({ bypassVitest: true, now: t0 + OVERVIEW_CACHE_TTL_MS - 1 })?.counts.total).toBe(8)
    expect(getCachedOverview({ bypassVitest: true, now: t0 + OVERVIEW_CACHE_TTL_MS })).toBeUndefined()
  })
})
