import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { registeredChannels } = vi.hoisted(() => ({
  registeredChannels: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ClipboardItem: class {},
  clipboard: {},
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string) => {
      registeredChannels.push(channel)
    })
  },
  nativeImage: {},
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: {}
}))

import { IpcChannel, type GalleryItemVO, type MoreFilterDTO } from '../../src/shared/api'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { registerIpcHandlers } from '../../src/main/ipc'
import { buildThumbResponse } from '../../src/main/protocol/ltmProtocol'
import { findGalleryRows } from '../../src/main/repositories/galleryRepository'
import {
  DEFAULT_ROOT_TTL_MS,
  filesForAction,
  invalidateRootOnlineCache,
  listGallery,
  matchMore,
  offlineRoots
} from '../../src/main/services/galleryService'

const NOW = new Date('2026-11-19T12:00:00.000Z')
const ONE_MB = 1024 * 1024
const TEN_MB = 10 * ONE_MB

let dir: string
let sourceA: string
let sourceB: string

function rowToMatchItem(row: Awaited<ReturnType<typeof findGalleryRows>>[number]): GalleryItemVO {
  return {
    imageId: row.imageId,
    fileId: row.fileId,
    name: row.displayName ?? row.relPath,
    format: row.format as GalleryItemVO['format'],
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    hash: row.contentHash,
    thumb: 'READY',
    missing: row.fileStatus === 'MISSING',
    offline: false,
    isR18: row.isR18,
    tagged: row.tagged,
    importedAt: row.createTime.toISOString(),
    takenAt: row.takenAt ? row.takenAt.toISOString() : null
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-gallery-perf-'))
  sourceA = join(dir, 'sourceA')
  sourceB = join(dir, 'sourceB')
  mkdirSync(sourceA, { recursive: true })
  mkdirSync(sourceB, { recursive: true })

  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  const { pg } = getDatabase()
  await pg.query(
    `INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'sourceA', $1), ('SOURCE', 'sourceB', $2)`,
    [sourceA, sourceB]
  )
  // 覆盖各类格式、宽高比、分辨率、体积、拍摄时间与多位置
  await pg.query(
    `INSERT INTO image (content_hash, format, byte_size, width, height, display_name, is_r18, thumb_ready, create_time, taken_at) VALUES
      ('h1', 'JPG',  $1, 4000, 3000, 'img-4k-h-m',     false, 1, '2026-11-18T10:00:00Z', '2026-11-10T08:00:00Z'),
      ('h2', 'PNG',  $2, 1080, 1920, 'img-fhd-v-s',    false, 1, '2026-11-17T10:00:00Z', '2026-06-01T08:00:00Z'),
      ('h3', 'WEBP', $3, 1000, 1000, 'img-fhd-sq-m10', false, 1, '2026-11-16T10:00:00Z', '2025-05-01T08:00:00Z'),
      ('h4', 'GIF',  $4,  800,  600, 'img-small-h-l',  false, 1, '2026-11-15T10:00:00Z', '2024-03-01T08:00:00Z'),
      ('h5', 'RAW',  $5, NULL, NULL, 'img-null-dim',   true,  1, '2026-11-14T10:00:00Z', NULL),
      ('h6', 'AVIF', $6,    0,  500, 'img-zero-w',     false, 1, '2026-11-13T10:00:00Z', '2026-10-25T08:00:00Z'),
      ('h7', 'JPG',  $7,  999,  999, 'img-small-sq-1', false, 1, '2026-11-13T10:00:00Z', NULL)`,
    [2 * ONE_MB, 500_000, TEN_MB, TEN_MB + 1, ONE_MB - 1, 2000, ONE_MB]
  )
  await pg.exec(`
    INSERT INTO image_file (image_id, root_id, rel_path, mtime, status) VALUES
      (1, 1, '1.jpg', now(), 'NORMAL'),
      (1, 2, '1-copy.jpg', now(), 'NORMAL'),
      (2, 1, '2.png', now(), 'NORMAL'),
      (3, 1, '3.webp', now(), 'NORMAL'),
      (4, 1, '4.gif', now(), 'NORMAL'),
      (5, 2, '5.arw', now(), 'NORMAL'),
      (6, 1, '6.avif', now(), 'NORMAL'),
      (7, 1, '7.jpg', now(), 'NORMAL');
    INSERT INTO tag (name, category_id) VALUES ('风景', 1);
    INSERT INTO image_tag (image_id, tag_id, source, status) VALUES
      (1, 1, 'MANUAL', 'ACCEPTED'),
      (2, 1, 'MANUAL', 'ACCEPTED'),
      (3, 1, 'MANUAL', 'ACCEPTED'),
      (4, 1, 'MANUAL', 'ACCEPTED'),
      (5, 1, 'MANUAL', 'ACCEPTED'),
      (6, 1, 'MANUAL', 'ACCEPTED'),
      (7, 1, 'MANUAL', 'ACCEPTED');
  `)
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  invalidateRootOnlineCache()
})

describe('buildThumbResponse 缩略图强缓存响应头', () => {
  it('添加 immutable Cache-Control 并补齐默认 image/webp Content-Type', () => {
    const upstream = new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
      status: 200,
      statusText: 'OK',
      headers: { 'X-Source': 'disk' }
    })
    const res = buildThumbResponse(upstream)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect(res.headers.get('X-Source')).toBe('disk')
  })

  it('保留上游已有的 Content-Type 并覆盖旧 Cache-Control', () => {
    const upstream = new Response('data', {
      status: 206,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }
    })
    const res = buildThumbResponse(upstream)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })
})

describe('PG 下推 more 筛选与排序', () => {
  it('5 组 more 筛选在 PG 查询与 matchMore 完全一致', async () => {
    const allRows = await findGalleryRows({ scope: 'all', recentDays: 30, sort: 'new', now: NOW })
    const uniqueByImage = new Map<number, GalleryItemVO>()
    for (const r of allRows) {
      if (!uniqueByImage.has(r.imageId)) uniqueByImage.set(r.imageId, rowToMatchItem(r))
    }
    const allItems = [...uniqueByImage.values()]

    const cases: MoreFilterDTO[] = [
      { fmt: ['JPG', 'RAW'] },
      { ori: ['h'] },
      { ori: ['v'] },
      { ori: ['sq'] },
      { ori: ['h', 'sq'] },
      { res: ['4k'] },
      { res: ['fhd'] },
      { res: ['small'] },
      { size: ['s'] },
      { size: ['m'] },
      { size: ['l'] },
      { date: ['30d'] },
      { date: ['y'] },
      { date: ['ly'] },
      { date: ['none'] },
      { fmt: ['JPG', 'WEBP'], ori: ['h', 'sq'], res: ['fhd'], size: ['m'], date: ['30d', 'ly'] },
      { fmt: [], ori: [], res: [], size: [], date: [] }
    ]

    for (const more of cases) {
      const sqlRows = await findGalleryRows({ scope: 'all', recentDays: 30, more, sort: 'new', now: NOW })
      const sqlIds = [...new Set(sqlRows.map((r) => r.imageId))].sort((a, b) => a - b)
      const jsIds = allItems
        .filter((item) => matchMore(item, more, NOW))
        .map((item) => item.imageId)
        .sort((a, b) => a - b)
      expect(sqlIds).toEqual(jsIds)
    }
  })

  it('new / old / taken / size 排序下推及同时间戳按 imageId 决胜', async () => {
    const byNew = (await listGallery({ view: 'all', sort: 'new' })).items.map((i) => i.imageId)
    expect(byNew).toEqual([1, 2, 3, 4, 5, 7, 6])

    const byOld = (await listGallery({ view: 'all', sort: 'old' })).items.map((i) => i.imageId)
    expect(byOld).toEqual([6, 7, 5, 4, 3, 2, 1])

    const byTaken = (await listGallery({ view: 'all', sort: 'taken' })).items.map((i) => i.imageId)
    expect(byTaken).toEqual([1, 6, 2, 3, 4, 5, 7])

    const bySize = (await listGallery({ view: 'all', sort: 'size' })).items.map((i) => i.imageId)
    expect(bySize).toEqual([4, 3, 1, 7, 5, 2, 6])

    const byName = (await listGallery({ view: 'all', sort: 'name' })).items.map((i) => i.imageId)
    expect(byName).toEqual([1, 3, 2, 5, 4, 7, 6])
  })
})

describe('根目录在线状态短 TTL 缓存与破坏性操作实时检查', () => {
  it('命中短 TTL 缓存、支持 invalidateRootOnlineCache 失效、filesForAction 强制 fresh 实时 stat', async () => {
    const tempRoot = join(dir, 'ephemeral-root')
    mkdirSync(tempRoot, { recursive: true })
    const { pg } = getDatabase()
    const inserted = await pg.query<{ id: number }>(
      `INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'ephemeral', $1) RETURNING id`,
      [tempRoot]
    )
    const rootId = inserted.rows[0].id
    const imgRes = await pg.query<{ id: number }>(
      `INSERT INTO image (content_hash, format, byte_size, thumb_ready) VALUES ('h-ephemeral', 'JPG', 123, 1) RETURNING id`
    )
    const imageId = imgRes.rows[0].id
    await pg.query(
      `INSERT INTO image_file (image_id, root_id, rel_path, mtime, status) VALUES ($1, $2, 'ephemeral.jpg', now(), 'NORMAL')`,
      [imageId, rootId]
    )

    const sample = [{ rootId, rootPath: tempRoot }]
    const t0 = Date.now()
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: t0 })).has(rootId)).toBe(false)

    // 删除目录，但在 TTL 内应继续命中在线缓存
    rmSync(tempRoot, { recursive: true, force: true })
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: t0 + 500 })).has(rootId)).toBe(false)

    // 超过 TTL 后自动重新 stat 并识别离线
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: t0 + DEFAULT_ROOT_TTL_MS + 1 })).has(rootId)).toBe(true)

    // 清除缓存后重新写入一个“误缓存为在线”的当前时间条目，验证 filesForAction 必须绕过缓存实查
    invalidateRootOnlineCache(rootId)
    mkdirSync(tempRoot, { recursive: true })
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: Date.now() })).has(rootId)).toBe(false)
    rmSync(tempRoot, { recursive: true, force: true })

    // filesForAction 使用 { fresh: true }，即使缓存还没过期也必须返回 offline: true
    const actionRows = await filesForAction({ view: 'all', sort: 'new' }, [imageId])
    expect(actionRows).toHaveLength(1)
    expect(actionRows[0].offline).toBe(true)

    // 再验证 invalidateRootOnlineCache 可显式清缓存（此时刚被 filesForAction 更新为 offline=true）
    mkdirSync(tempRoot, { recursive: true })
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: Date.now() })).has(rootId)).toBe(true)
    invalidateRootOnlineCache(rootId)
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: Date.now() })).has(rootId)).toBe(false)
    rmSync(tempRoot, { recursive: true, force: true })
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: Date.now() })).has(rootId)).toBe(false)
    invalidateRootOnlineCache(rootId)
    expect((await offlineRoots(sample, { ttlMs: DEFAULT_ROOT_TTL_MS, now: Date.now() })).has(rootId)).toBe(true)
  })
})

describe('IPC 按领域拆分注册完整性', () => {
  it('registerIpcHandlers 注册全部 IpcChannel 且无遗漏无重复', () => {
    registeredChannels.length = 0
    registerIpcHandlers(
      {
        root: dir,
        pgdata: join(dir, 'pgdata'),
        lockFile: join(dir, 'db.lock'),
        thumbs: join(dir, 'thumbs'),
        models: join(dir, 'models'),
        backgrounds: join(dir, 'backgrounds'),
        logs: join(dir, 'logs'),
        categoryHomeOverride: null
      },
      { pgdata: join(dir, 'pgdata'), lockFile: join(dir, 'db.lock'), migrationsFolder: resolve('drizzle') },
      async () => undefined
    )
    const expected = Object.values(IpcChannel)
    expect(registeredChannels).toHaveLength(expected.length)
    expect(new Set(registeredChannels)).toEqual(new Set(expected))
  })
})
