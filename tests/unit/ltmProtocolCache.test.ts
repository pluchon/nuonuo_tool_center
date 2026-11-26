import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THUMB_CACHE_MAX_BYTES,
  THUMB_CACHE_MAX_ENTRIES,
  THUMB_CACHE_MAX_SINGLE_BYTES,
  clearThumbProtocolCache,
  handleThumbRequest
} from '../../src/main/protocol/ltmProtocol'

function hashName(index: number): string {
  return `${index.toString(16).padStart(64, '0')}.webp`
}

describe('ltm://thumb 协议内存 LRU 缓存', () => {
  beforeEach(() => {
    clearThumbProtocolCache()
  })

  afterEach(() => {
    clearThumbProtocolCache()
  })

  it('首次读取触发磁盘 reader 并带 immutable 强缓存头，二次命中不重复读盘', async () => {
    const name = hashName(1)
    const payload = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])
    const reader = vi.fn(async () => payload)

    const first = await handleThumbRequest('/thumbs', name, reader)
    expect(first.status).toBe(200)
    expect(first.headers.get('Content-Type')).toBe('image/webp')
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload)
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith(join('/thumbs', name))

    const second = await handleThumbRequest('/thumbs', name, reader)
    expect(second.status).toBe(200)
    expect(second.headers.get('Content-Type')).toBe('image/webp')
    expect(second.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(payload)
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('超出 16 MiB 总字节上限时按 LRU 淘汰最久未用项，并保留刚命中的 MRU 项', async () => {
    const chunkSize = THUMB_CACHE_MAX_SINGLE_BYTES
    const capacity = THUMB_CACHE_MAX_BYTES / chunkSize
    const reader = vi.fn(async (filePath: string) => {
      const marker = Number.parseInt(filePath.slice(-10, -5), 16) & 0xff
      return new Uint8Array(chunkSize).fill(marker)
    })

    for (let i = 0; i < capacity; i++) {
      const res = await handleThumbRequest('/thumbs', hashName(i), reader)
      expect(res.status).toBe(200)
    }
    expect(reader).toHaveBeenCalledTimes(capacity)

    // 命中第 0 项，将其提升到 MRU，第 1 项成为最久未用
    await handleThumbRequest('/thumbs', hashName(0), reader)
    expect(reader).toHaveBeenCalledTimes(capacity)

    // 再写入 1 项，触发淘汰第 1 项
    await handleThumbRequest('/thumbs', hashName(capacity), reader)
    expect(reader).toHaveBeenCalledTimes(capacity + 1)

    // 第 0 项仍在缓存中（不读盘）
    await handleThumbRequest('/thumbs', hashName(0), reader)
    expect(reader).toHaveBeenCalledTimes(capacity + 1)

    // 第 1 项已被淘汰（重新读盘）
    await handleThumbRequest('/thumbs', hashName(1), reader)
    expect(reader).toHaveBeenCalledTimes(capacity + 2)
  })

  it('超出 400 条目上限时按 LRU 淘汰最久未用项', async () => {
    const reader = vi.fn(async () => new Uint8Array([1, 2, 3, 4]))

    for (let i = 0; i < THUMB_CACHE_MAX_ENTRIES; i++) {
      const res = await handleThumbRequest('/thumbs', hashName(i), reader)
      expect(res.status).toBe(200)
    }
    expect(reader).toHaveBeenCalledTimes(THUMB_CACHE_MAX_ENTRIES)

    // 命中第 0 项使其成为 MRU
    await handleThumbRequest('/thumbs', hashName(0), reader)
    expect(reader).toHaveBeenCalledTimes(THUMB_CACHE_MAX_ENTRIES)

    // 插入第 401 项，应淘汰第 1 项
    await handleThumbRequest('/thumbs', hashName(THUMB_CACHE_MAX_ENTRIES), reader)
    expect(reader).toHaveBeenCalledTimes(THUMB_CACHE_MAX_ENTRIES + 1)

    // 第 0 项命中，第 1 项未命中
    await handleThumbRequest('/thumbs', hashName(0), reader)
    expect(reader).toHaveBeenCalledTimes(THUMB_CACHE_MAX_ENTRIES + 1)

    await handleThumbRequest('/thumbs', hashName(1), reader)
    expect(reader).toHaveBeenCalledTimes(THUMB_CACHE_MAX_ENTRIES + 2)
  })

  it('超过 256 KiB 的缩略图跳过缓存但仍正常返回，恰好 256 KiB 会缓存', async () => {
    const oversizedName = hashName(1001)
    const exactName = hashName(1002)
    const oversizedReader = vi.fn(async () => new Uint8Array(THUMB_CACHE_MAX_SINGLE_BYTES + 1).fill(7))
    const exactReader = vi.fn(async () => new Uint8Array(THUMB_CACHE_MAX_SINGLE_BYTES).fill(9))

    const r1 = await handleThumbRequest('/thumbs', oversizedName, oversizedReader)
    const r2 = await handleThumbRequest('/thumbs', oversizedName, oversizedReader)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect((await r2.arrayBuffer()).byteLength).toBe(THUMB_CACHE_MAX_SINGLE_BYTES + 1)
    expect(oversizedReader).toHaveBeenCalledTimes(2)

    const e1 = await handleThumbRequest('/thumbs', exactName, exactReader)
    const e2 = await handleThumbRequest('/thumbs', exactName, exactReader)
    expect(e1.status).toBe(200)
    expect(e2.status).toBe(200)
    expect(exactReader).toHaveBeenCalledTimes(1)
  })

  it('文件缺失或文件名非法时返回 404，且不写入缓存', async () => {
    const missingName = hashName(2001)
    const reader = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const missing = await handleThumbRequest('/thumbs', missingName, reader)
    expect(missing.status).toBe(404)
    expect(reader).toHaveBeenCalledTimes(1)

    const invalid = await handleThumbRequest('/thumbs', '../secret.webp', reader)
    expect(invalid.status).toBe(404)
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('clearThumbProtocolCache 会清空所有缓存并让后续请求重新读盘', async () => {
    const name = hashName(3001)
    const reader = vi.fn(async () => new Uint8Array([9, 8, 7]))

    await handleThumbRequest('/thumbs', name, reader)
    await handleThumbRequest('/thumbs', name, reader)
    expect(reader).toHaveBeenCalledTimes(1)

    clearThumbProtocolCache()

    await handleThumbRequest('/thumbs', name, reader)
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('默认读盘路径可读取真实文件，文件被删除前命中缓存、清理缓存后返回 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ltm-proto-'))
    const name = hashName(4001)
    const file = join(dir, name)
    try {
      writeFileSync(file, Buffer.from([10, 20, 30, 40]))
      const hit1 = await handleThumbRequest(dir, name)
      expect(hit1.status).toBe(200)
      expect(new Uint8Array(await hit1.arrayBuffer())).toEqual(new Uint8Array([10, 20, 30, 40]))

      rmSync(file)
      const hitFromMem = await handleThumbRequest(dir, name)
      expect(hitFromMem.status).toBe(200)

      clearThumbProtocolCache()
      const afterClear = await handleThumbRequest(dir, name)
      expect(afterClear.status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
