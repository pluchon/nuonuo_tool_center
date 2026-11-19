import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { changeCategoryHome } from '../../src/main/services/categoryHome'
import { getSettings, updateSettings } from '../../src/main/services/settingsService'
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
    const first = await importCustomBackground(src, bgDir, 1_700_000_000_000)
    expect(first).toBe('custom-1700000000000.webp')
    expect((await sharp(join(bgDir, first)).metadata()).width).toBe(2560)
    const second = await importCustomBackground(src, bgDir, 1_700_000_000_001)
    expect(readdirSync(bgDir)).toEqual([second])
    writeFileSync(join(bgDir, 'custom-1700000000005.webp'), 'old')
    writeFileSync(join(bgDir, 'other.webp'), 'not mine')
    await pruneBackgrounds(bgDir, second)
    expect(readdirSync(bgDir).sort()).toEqual([second, 'other.webp'])
    await expect(importCustomBackground(join(dir, 'missing.png'), bgDir)).rejects.toThrow('这张图读不了')
  })

  it('导出备份：写一个压缩包，不覆盖已有文件', async () => {
    const target = join(dir, backupFileName(new Date(2026, 10, 19, 9, 5)))
    expect(target.endsWith('诺诺图床备份-20261119-0905.tar.gz')).toBe(true)
    expect(await exportBackup(target)).toBeGreaterThan(1000)
    expect(existsSync(target)).toBe(true)
    await expect(exportBackup(target)).rejects.toThrow('同名文件')
  })

  it('开机自动启动只在正式使用时登记', () => {
    expect(canTouchLoginItem({})).toBe(true)
    expect(canTouchLoginItem({ LTM_DATA_DIR: 'D:\\ltm-dev\\data' })).toBe(false)
  })
})
