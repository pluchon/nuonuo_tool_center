import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { open, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { changeCategoryHome } from '../../src/main/services/categoryHome'
import { getSettings, updateSettings } from '../../src/main/services/settingsService'
import * as settingsService from '../../src/main/services/settingsService'
import { bmp24 } from '../support/bmp'
import {
  backupFileName,
  canTouchLoginItem,
  cleanThumbCache,
  exportBackup,
  folderBytes,
  importCustomBackground,
  pruneBackgrounds
} from '../../src/main/services/systemService'

sharp.cache(false)

let dir: string
let source: string
let library: string
let data: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-system-'))
  source = join(dir, 'pics')
  library = join(dir, 'library')
  data = join(dir, 'data')
  for (const d of [source, library, join(data, 'thumbs')]) {
    mkdirSync(d, { recursive: true })
  }
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  await updateSettings({ categoryHome: library })
  const { pg } = getDatabase()
  await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1), ('CATEGORY', '类目录', $2)`, [source, library])
  await pg.exec(`
    INSERT INTO image (content_hash, format, byte_size) VALUES ('${'a'.repeat(64)}', 'JPG', 1), ('${'b'.repeat(64)}', 'JPG', 1);
    INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, 'x.jpg', now()), (2, 2, 'y.jpg', now());
  `)
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('设置里和系统打交道的几项', () => {
  it('清理缩略图缓存：只删库里没有的', async () => {
    const thumbs = join(data, 'thumbs')
    writeFileSync(join(thumbs, `${'a'.repeat(64)}.webp`), 'keep')
    writeFileSync(join(thumbs, `${'c'.repeat(64)}.webp`), 'orphan!')
    writeFileSync(join(thumbs, 'note.txt'), 'not a thumb')
    expect(await folderBytes(thumbs)).toBe(4 + 7 + 11)
    expect(await cleanThumbCache(thumbs)).toEqual({ removed: 1, freedBytes: 7 })
    expect(readdirSync(thumbs).sort()).toEqual([`${'a'.repeat(64)}.webp`, 'note.txt'])
  })

  it('换类目录位置：类目录里还有图时不换；不能和源目录、数据文件夹重叠；有环境变量时不能改', async () => {
    const empty = join(dir, 'new-home')
    mkdirSync(empty)
    await expect(changeCategoryHome(empty, null, data)).rejects.toThrow('类目录里还有 1 张图')
    await expect(changeCategoryHome(join(source), null, data)).rejects.toThrow('和源目录「pics」重叠')
    mkdirSync(join(data, 'inside'))
    await expect(changeCategoryHome(join(data, 'inside'), null, data)).rejects.toThrow('数据文件夹')
    await expect(changeCategoryHome(empty, 'D:\\x', data)).rejects.toThrow('环境变量')
    await expect(changeCategoryHome(join(dir, 'nope'), null, data)).rejects.toThrow('找不到')

    // 类目录空了就能换，库里的类目录跟着指过去
    await getDatabase().pg.exec(`UPDATE image_file SET delete_state = 1 WHERE root_id = 2`)
    expect(await changeCategoryHome(empty, null, data)).toBe(empty)
    expect((await getSettings()).categoryHome).toBe(empty)
    const { rows } = await getDatabase().pg.query<{ path: string }>(`SELECT path FROM library_root WHERE kind = 'CATEGORY' AND delete_state = 0`)
    expect(rows.map((r) => r.path)).toEqual([empty])
  })

  it('自定义背景：缩到 2560 存成 webp，旧的删掉', async () => {
    const bgDir = join(data, 'backgrounds')
    const src = join(dir, 'big.png')
    await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#9FC9A8' } }).png().toFile(src)
    const { customBackground: first } = await importCustomBackground(src, bgDir, 1_700_000_000_000)
    expect(first).toBe('custom-1700000000000.webp')
    expect((await sharp(join(bgDir, first!)).metadata()).width).toBe(2560)
    const fail = vi.spyOn(settingsService, 'updateSettings').mockRejectedValueOnce(new Error('模拟保存失败'))
    try {
      await expect(importCustomBackground(src, bgDir, 1_700_000_000_000)).rejects.toThrow('模拟保存失败')
      expect((await getSettings()).customBackground).toBe(first)
      expect((await sharp(join(bgDir, first!)).metadata()).width).toBe(2560)
    } finally { fail.mockRestore() }
    const [a, b] = await Promise.all([
      importCustomBackground(src, bgDir, 1_700_000_000_001),
      importCustomBackground(src, bgDir, 1_700_000_000_001)
    ])
    const second = b.customBackground
    expect(second).not.toBe(a.customBackground)
    expect((await getSettings()).customBackground).toBe(second)
    expect(readdirSync(bgDir)).toEqual([second])
    writeFileSync(join(bgDir, 'custom-1700000000005.webp'), 'old')
    writeFileSync(join(bgDir, 'other.webp'), 'not mine')
    await pruneBackgrounds(bgDir, second)
    expect(readdirSync(bgDir).sort()).toEqual([second, 'other.webp'])
    await expect(importCustomBackground(join(dir, 'missing.png'), bgDir)).rejects.toThrow('这张图读不了')
  })

  it('导出备份：独立数据库可以从压缩包恢复图片和目录，不覆盖已有文件', async () => {
    const target = join(dir, backupFileName(new Date(2026, 10, 19, 9, 5)))
    const list = 'select r.path, f.rel_path, f.delete_state from image_file f join library_root r on r.id = f.root_id order by f.id'
    const original = await getDatabase().pg.query(list)
    expect(original.rows).toHaveLength(2)
    expect(target.endsWith('诺诺图床备份-20261119-0905.tar.gz')).toBe(true)
    expect(await exportBackup(target)).toBeGreaterThan(1000)
    expect(existsSync(target)).toBe(true)
    await expect(exportBackup(target)).rejects.toThrow('同名文件')
    const restored = await PGlite.create({ loadDataDir: new Blob([Uint8Array.from(readFileSync(target))]), extensions: { vector } })
    try {
      expect((await restored.query(list)).rows).toEqual(original.rows)
    } finally {
      await restored.close()
    }
  })

  it('开机自动启动只在正式使用时登记', () => {
    expect(canTouchLoginItem({})).toBe(true)
    expect(canTouchLoginItem({ LTM_DATA_DIR: 'D:\\ltm-dev\\data' })).toBe(false)
  })

  it('背景选择器支持真实 BMP，重开读取的 WebP 保留原始尺寸', async () => {
    const file = join(dir, '背景.BMP')
    writeFileSync(file, bmp24(60, 35))
    const bgDir = join(data, 'backgrounds')
    const saved = await importCustomBackground(file, bgDir)
    expect((await getSettings()).customBackground).toBe(saved.customBackground)
    expect(await sharp(join(bgDir, saved.customBackground!)).metadata()).toMatchObject({ format: 'webp', width: 60, height: 35 })
  })

  it('备份写入一半磁盘空间不足，清理临时文件，相同路径仍可重试', async () => {
    const output = join(dir, '磁盘空间测试')
    mkdirSync(output)
    const target = join(output, 'backup.tar.gz')
    const probe = await open(join(dir, 'handle'), 'w')
    const prototype: FileHandle = Object.getPrototypeOf(probe)
    await probe.close()
    const write = vi.spyOn(prototype, 'writeFile').mockImplementationOnce(async function (this: FileHandle) {
      await this.write(Buffer.from('partial'))
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    })
    try {
      await expect(exportBackup(target)).rejects.toThrow('ENOSPC')
      expect(readdirSync(output)).toEqual([])
    } finally {
      write.mockRestore()
    }
    expect(await exportBackup(target)).toBeGreaterThan(1000)
  })
})
