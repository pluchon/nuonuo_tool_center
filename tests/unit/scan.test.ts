import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { bmp24 } from '../support/bmp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { lockOf } from '../../src/main/services/folderService'
import { addRoot, getOverview, relocateRoot } from '../../src/main/services/libraryService'
import { decodeBmp } from '../../src/main/services/scan/bmpDecoder'
import { parseExif } from '../../src/main/services/scan/exifInfo'
import { largestEmbeddedJpeg } from '../../src/main/services/scan/rawPreview'
import { configureScan, getScanState, startScan, whenScanIdle } from '../../src/main/services/scan/scanService'
import { updateSettings } from '../../src/main/services/settingsService'

let dir: string
let home: string
let source: string
let thumbs: string

// 生成一张纯色图
function solid(width: number, height: number, color: string): ReturnType<typeof sharp> {
  return sharp({ create: { width, height, channels: 3, background: color } })
}

// 查某个目录的文件记录（含逻辑删除的）
async function filesOf(rootId: number): Promise<Array<{ rel_path: string; status: string; delete_state: number; image_id: number }>> {
  const { pg } = getDatabase()
  const res = await pg.query<{ rel_path: string; status: string; delete_state: number; image_id: number }>(
    'select rel_path, status, delete_state, image_id::int as image_id from image_file where root_id = $1 order by rel_path, id',
    [rootId]
  )
  return res.rows
}

// 扫一遍并等它做完
async function scanAndWait(rootId: number | null): Promise<void> {
  startScan(rootId)
  await whenScanIdle()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-scan-'))
  home = join(dir, 'library')
  source = join(dir, 'pics')
  thumbs = join(dir, 'thumbs')
  mkdirSync(join(source, 'sub'), { recursive: true })
  mkdirSync(join(source, '.hidden'), { recursive: true })
  mkdirSync(join(home, '猫猫'), { recursive: true })
  mkdirSync(thumbs)

  const jpg = await solid(64, 48, '#7A63C9')
    .withExif({
      IFD0: { Make: 'SONY', Model: 'ILCE-7M4' },
      IFD2: { DateTimeOriginal: '2025:10:03 09:12:44', FNumber: '4/1', ExposureTime: '1/250', FocalLength: '35/1', ISOSpeedRatings: '100' }
    })
    .jpeg()
    .toBuffer()
  writeFileSync(join(source, 'a.jpg'), jpg)
  writeFileSync(join(source, 'sub', 'a-copy.jpg'), jpg)
  await solid(30, 60, '#C25B85').png().toFile(join(source, 'b.png'))
  await solid(80, 20, '#3F8F7B').webp().toFile(join(source, 'sub', 'c.webp'))
  writeFileSync(join(source, 'd.bmp'), bmp24(5, 3))
  writeFileSync(join(source, 'e.heic'), Buffer.from('not really a heic file'))
  // 假 RAW：TIFF 头 + 一段垃圾 + 内嵌一张大 JPEG
  const preview = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#B8732E', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .jpeg()
    .toBuffer()
  writeFileSync(join(source, 'f.arw'), Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(300), preview, Buffer.alloc(100)]))
  writeFileSync(join(source, 'note.txt'), 'hi')
  writeFileSync(join(source, '.hidden', 'x.jpg'), jpg)
  await solid(10, 10, '#FFFFFF').png().toFile(join(home, '猫猫', 'cat.png'))

  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  configureScan({ thumbsDir: thumbs, categoryHomeOverride: home })
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('解码小工具', () => {
  it('BMP：24 位从下往上存的行能还原成正确的像素', () => {
    const px = decodeBmp(bmp24(5, 3))
    expect(px).toMatchObject({ width: 5, height: 3, channels: 3 })
    expect([...px!.data.subarray(0, 6)]).toEqual([255, 0, 0, 0, 0, 255])
    expect(decodeBmp(Buffer.from('BMnope'))).toBeNull()
  })

  it('RAW：取最大的内嵌 JPEG，小缩略图不要', async () => {
    const small = await solid(8, 8, '#000').jpeg().toBuffer()
    const big = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#888', noise: { type: 'gaussian', mean: 128, sigma: 50 } } })
      .jpeg()
      .toBuffer()
    const raw = Buffer.concat([Buffer.alloc(50), small, Buffer.alloc(20), big, Buffer.alloc(20)])
    expect(largestEmbeddedJpeg(raw)?.equals(big)).toBe(true)
    expect(largestEmbeddedJpeg(Buffer.concat([Buffer.alloc(10), small]))).toBeNull()
  })

  it('EXIF：拍摄时间按墙上时间还原，坏数据返回空', async () => {
    const jpg = await solid(4, 4, '#fff')
      .withExif({ IFD0: { Make: 'Canon\0' }, IFD2: { DateTimeOriginal: '2026:01:02 03:04:05' } })
      .jpeg()
      .toBuffer()
    const meta = await sharp(jpg).metadata()
    const parsed = parseExif(meta.exif)
    expect(parsed.info).toEqual({ make: 'Canon' })
    expect(parsed.takenAt?.toString()).toBe(new Date(2026, 0, 2, 3, 4, 5).toString())
    expect(parseExif(Buffer.from('garbage-data'))).toEqual({ info: null, takenAt: null })
  })

  it('导入对话框：图库文件夹、已导入、含已导入的文件夹不能选', () => {
    const sources = ['D:\\pics']
    expect(lockOf('D:\\诺诺图床', 'D:\\诺诺图床', sources)).toBe('LIBRARY')
    expect(lockOf('D:\\诺诺图床\\猫猫', 'D:\\诺诺图床', sources)).toBe('LIBRARY')
    expect(lockOf('d:\\PICS\\2024', 'D:\\诺诺图床', sources)).toBe('IMPORTED')
    expect(lockOf('D:\\', 'D:\\诺诺图床', sources)).toBe('HOLDS')
    expect(lockOf('D:\\other', 'D:\\诺诺图床', sources)).toBeNull()
  })
})

describe('扫描', () => {
  let rootId: number

  it('导入后自动扫描：登记图片、同内容只建一张图、生成缩略图、读出 EXIF；跳过隐藏目录和非图片', async () => {
    rootId = (await addRoot(source, home)).id
    await whenScanIdle()
    const files = await filesOf(rootId)
    expect(files.map((f) => f.rel_path)).toEqual(['a.jpg', 'b.png', 'd.bmp', 'e.heic', 'f.arw', 'sub\\a-copy.jpg', 'sub\\c.webp'])
    expect(files.every((f) => f.status === 'NORMAL')).toBe(true)
    expect(files.find((f) => f.rel_path === 'a.jpg')?.image_id).toBe(files.find((f) => f.rel_path === 'sub\\a-copy.jpg')?.image_id)

    const { pg } = getDatabase()
    const images = await pg.query<{ format: string; width: number | null; height: number | null; thumb_ready: number; content_hash: string; exif: unknown; taken_at: Date | null }>(
      'select format, width, height, thumb_ready, content_hash, exif, taken_at from image order by id'
    )
    const byFormat = Object.fromEntries(images.rows.map((r) => [r.format, r]))
    expect(images.rows).toHaveLength(6)
    expect(byFormat.JPG).toMatchObject({ width: 64, height: 48, thumb_ready: 1 })
    expect(byFormat.JPG.exif).toEqual({ make: 'SONY', model: 'ILCE-7M4', focalLength: 35, fNumber: 4, exposureTime: 0.004, iso: 100 })
    expect(new Date(byFormat.JPG.taken_at!).getTime()).toBe(new Date(2025, 9, 3, 9, 12, 44).getTime())
    expect(byFormat.BMP).toMatchObject({ width: 5, height: 3, thumb_ready: 1 })
    expect(byFormat.RAW).toMatchObject({ width: 600, height: 400, thumb_ready: 1 })
    expect(byFormat.HEIC).toMatchObject({ width: null, thumb_ready: 2 })
    for (const r of images.rows.filter((x) => x.thumb_ready === 1)) {
      expect(existsSync(join(thumbs, `${r.content_hash}.webp`))).toBe(true)
    }
    const ov = await getOverview(home)
    expect(ov.counts.total).toBe(6)
    expect(ov.lastScanAt).not.toBeNull()
    expect(getScanState().last).toMatchObject({ rootName: 'pics', total: 7, found: 7, added: 7, stopped: false, failed: 0 })
    await scanAndWait(rootId)
    expect(getScanState().last?.added).toBe(0)
  })

  it('扫描全部：类目录也登记进来，计数到对应的顶层类目录', async () => {
    await scanAndWait(null)
    const ov = await getOverview(home)
    expect(ov.categories).toEqual([{ name: '猫猫', count: 1, hasChildren: false }])
    expect(ov.counts.total).toBe(7)
    expect(getScanState().last?.added).toBe(1)
  })

  it('文件被外部删掉就从图库里去掉；被挪到别处的按哈希接上，旧记录去掉；放回来按内容认回原来的图', async () => {
    rmSync(join(source, 'b.png'))
    mkdirSync(join(source, 'sub2'))
    renameSync(join(source, 'sub', 'c.webp'), join(source, 'sub2', 'c.webp'))
    await scanAndWait(rootId)
    let files = await filesOf(rootId)
    const c = files.filter((f) => f.rel_path.endsWith('c.webp')).sort((x, y) => y.delete_state - x.delete_state)
    expect(c.map((f) => [f.rel_path, f.status, f.delete_state])).toEqual([
      ['sub\\c.webp', 'NORMAL', 1],
      ['sub2\\c.webp', 'NORMAL', 0]
    ])
    expect(c[0].image_id).toBe(c[1].image_id)
    const goneB = files.filter((f) => f.rel_path === 'b.png')
    expect(goneB.map((f) => f.delete_state)).toEqual([1])

    await solid(30, 60, '#C25B85').png().toFile(join(source, 'b.png'))
    await scanAndWait(rootId)
    files = await filesOf(rootId)
    const backB = files.filter((f) => f.rel_path === 'b.png' && f.delete_state === 0)
    expect(backB.map((f) => [f.status, f.image_id])).toEqual([['NORMAL', goneB[0].image_id]])
  })

  it('设置里不扫某种格式：已有的这类记录不会被当成“不见了”', async () => {
    await updateSettings({ scanFormats: ['JPG'] })
    await scanAndWait(rootId)
    const files = await filesOf(rootId)
    expect(files.filter((f) => f.delete_state === 0).every((f) => f.status === 'NORMAL')).toBe(true)
    await updateSettings({ scanFormats: ['JPG', 'PNG', 'GIF', 'WEBP', 'BMP', 'AVIF', 'HEIC', 'RAW'] })
  })

  it('源目录找不到时什么都不改，侧栏标“找不到”；重新选择位置后按原来的记录接上', async () => {
    const before = await filesOf(rootId)
    const moved = join(dir, 'pics-moved')
    renameSync(source, moved)
    await scanAndWait(null)
    expect(await filesOf(rootId)).toEqual(before)
    expect(getScanState().last).toMatchObject({ unreadableDirs: 1, added: 0 })
    expect((await getOverview(home)).sources[0]).toMatchObject({ offline: true, hasChildren: false })

    await relocateRoot(rootId, moved, home)
    await whenScanIdle()
    const after = await filesOf(rootId)
    expect(after).toEqual(before)
    expect((await getOverview(home)).sources[0]).toMatchObject({ offline: false, path: moved, name: 'pics' })
  })
})
