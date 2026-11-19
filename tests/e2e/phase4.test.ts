import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { pickFolder } from './support/picker'

afterEach(async () => {
  await closeLeftoverApps()
})

// 不同颜色、不同比例的测试图
const COLORS = ['#F6CDD8', '#D8CCEF', '#BFE3D6', '#EED3B3', '#BBD5EE', '#E0C6E8', '#EEDFA3', '#CCD8E2']
const SIZES: Array<[number, number]> = [
  [640, 480],
  [480, 640],
  [800, 450],
  [500, 500],
  [900, 600],
  [400, 700]
]

// 生成一张纯色加噪点的图（噪点保证每张内容不同）
async function makeImage(file: string, w: number, h: number, color: string, seed: number): Promise<void> {
  await sharp({ create: { width: w, height: h, channels: 3, background: color, noise: { type: 'gaussian', mean: 100 + (seed % 40), sigma: 12 } } })
    .modulate({ brightness: 1.6 })
    .jpeg({ quality: 85 })
    .toFile(file)
}

// 网格里所有图的名字（按显示顺序）
async function tileNames(page: Page): Promise<string[]> {
  return page.locator('.tile .tile__name').allTextContents()
}

describe('第四阶段：图片网格', () => {
  it('源目录网格：排版、按月分组、选中、多选、键盘、缩放、搜索；类目录排序；详情面板', async () => {
    const dirs = freshCase('phase4-grid')
    const source = join(dirs.root, 'pics')
    mkdirSync(join(source, '旅行'), { recursive: true })
    for (let i = 0; i < 18; i++) {
      const [w, h] = SIZES[i % SIZES.length]
      await makeImage(join(source, i < 12 ? '' : '旅行', `photo-${String(i).padStart(2, '0')}.jpg`), w, h, COLORS[i % COLORS.length], i)
    }
    // 全景、长图、带拍摄信息的照片、解不开的 HEIC
    await makeImage(join(source, 'panorama.jpg'), 1500, 400, '#BBD5EE', 90)
    await makeImage(join(source, 'long-shot.jpg'), 300, 1200, '#F6CDD8', 91)
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#BFE3D6', noise: { type: 'gaussian', mean: 120, sigma: 10 } } })
      .withExif({
        IFD0: { Make: 'SONY', Model: 'ILCE-7M4' },
        IFD2: { DateTimeOriginal: '2025:10:03 09:12:44', FNumber: '4/1', ExposureTime: '1/250', FocalLength: '35/1', ISOSpeedRatings: '100', LensModel: 'FE 24-70mm F2.8 GM II' }
      })
      .jpeg()
      .toFile(join(source, 'DSC09412.jpg'))
    writeFileSync(join(source, 'broken.heic'), Buffer.from('not a heic'))
    // 类目录：名字有中文有英文，用来看名称排序
    mkdirSync(join(dirs.library, '壁纸'), { recursive: true })
    for (const [i, name] of ['海边.jpg', 'b-2.jpg', 'a-10.jpg', 'a-9.jpg', '晚霞.jpg'].entries()) {
      await makeImage(join(dirs.library, '壁纸', name), 640, 400 + i * 30, COLORS[i], 50 + i)
    }

    const { app, page } = await launchApp(dirs)
    await page.click('.gallery__pick')
    await pickFolder(page, source)
    await page.click('.folder-pick__confirm')
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 22)

    // 按导入月份分组（都是本月导入）；每一行（除最后一行）都对齐右边
    const months = await page.locator('.image-grid__title').allTextContents()
    const now = new Date()
    expect(months).toEqual([`${now.getFullYear()} 年 ${now.getMonth() + 1} 月`])
    const rowsAligned = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('.image-grid__row')]
      return rows.slice(0, -1).map((r) => {
        const tiles = [...r.querySelectorAll<HTMLElement>('.tile')]
        const right = tiles[tiles.length - 1].getBoundingClientRect().right
        return Math.round(r.getBoundingClientRect().right - 2 - right)
      })
    })
    expect(rowsAligned.every((gap) => Math.abs(gap) <= 1)).toBe(true)
    await expect(page.locator('.tile:has-text("panorama.jpg") .tile__badge--crop').textContent()).resolves.toBe('全景')
    await expect(page.locator('.tile:has-text("long-shot.jpg") .tile__badge--crop').textContent()).resolves.toBe('长图')
    await expect(page.locator('.tile:has-text("broken.heic") .tile__bad').innerText()).resolves.toContain('无法预览')
    // 缩略图都真的加载出来了
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.tile__pic')].slice(0, 6).every((i) => i.complete && i.naturalWidth > 0))

    // 默认选中一张（扫描中刷新时选中的那张会保留），详情面板显示的就是它
    await expect(page.locator('.tile--on').count()).resolves.toBe(1)
    const selectedName = await page.locator('.tile--on .tile__name').textContent()
    await expect(page.locator('.detail-panel__name').textContent()).resolves.toBe(selectedName)
    await shot(page, 'grid-light')

    // 点带拍摄信息的照片：详情显示拍摄信息
    await page.click('.tile:has-text("DSC09412.jpg")')
    await expect(page.locator('.detail-panel__name').textContent()).resolves.toBe('DSC09412.jpg')
    await expect(page.locator('.detail-panel__exif-val').allTextContents()).resolves.toEqual(['SONY ILCE-7M4', 'FE 24-70mm F2.8 GM II'])
    await expect(page.locator('.detail-panel__param-v').allTextContents()).resolves.toEqual(['35mm', 'f/4', '1/250s', '100'])
    await expect(page.locator('.detail-panel__taken').textContent()).resolves.toBe('2025-10-03 09:12:44')
    await expect(page.locator('.detail-panel__path-text').textContent()).resolves.toBe(join(source, 'DSC09412.jpg'))
    await shot(page, 'grid-exif-light')

    // 解不开的图：详情提示“无法预览”
    await page.click('.tile:has-text("broken.heic")')
    await expect(page.locator('.detail-panel__notice').innerText()).resolves.toContain('无法预览')

    // Ctrl 点击加选、Shift 连选、Esc 回到单选、Ctrl + A 全选
    const names = await tileNames(page)
    await page.click(`.tile:has-text("${names[0]}")`)
    await page.click(`.tile:has-text("${names[2]}")`, { modifiers: ['Control'] })
    await expect(page.locator('.detail-panel__batch-num').textContent()).resolves.toBe('2')
    await page.click(`.tile:has-text("${names[5]}")`, { modifiers: ['Shift'] })
    await expect(page.locator('.tile--on').count()).resolves.toBe(4)
    await shot(page, 'grid-multi-light')
    await page.keyboard.press('Escape')
    await expect(page.locator('.tile--on').count()).resolves.toBe(1)
    await page.keyboard.press('Control+a')
    await expect(page.locator('.detail-panel__batch-num').textContent()).resolves.toBe('22')
    await page.keyboard.press('Escape')

    // 方向键：→ 下一张，↓ 下一行
    await page.click(`.tile:has-text("${names[0]}")`)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.tile--on .tile__name').textContent()).resolves.toBe(names[1])
    const rowOf = (n: string): Promise<number> =>
      page.evaluate((name) => {
        const rows = [...document.querySelectorAll('.image-grid__row')]
        return rows.findIndex((r) => [...r.querySelectorAll('.tile__name')].some((e) => e.textContent === name))
      }, n)
    const before = await rowOf(names[1])
    await page.keyboard.press('ArrowDown')
    const after = await rowOf((await page.locator('.tile--on .tile__name').textContent()) ?? '')
    expect(after).toBe(before + 1)

    // Ctrl + 滚轮换档：变小后每行放更多
    const heightOf = (): Promise<number> => page.locator('.tile__img').first().evaluate((e) => e.getBoundingClientRect().height)
    expect(Math.round(await heightOf())).toBe(140)
    await page.mouse.move(600, 400)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, 100)
    await page.keyboard.up('Control')
    await page.waitForFunction(() => Math.round(document.querySelector('.tile__img')?.getBoundingClientRect().height ?? 0) === 115)

    // 搜索：按名字过滤；没结果时空状态
    await page.fill('.filter-bar__input', 'photo-1')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8)
    await page.fill('.filter-bar__input', '不存在的图')
    await page.waitForSelector('.gallery__empty')
    await expect(page.locator('.gallery__empty .gallery__text').textContent()).resolves.toBe('没有找到「不存在的图」')
    await page.click('.filter-bar__clear')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 22)

    // 仅当前目录：去掉子文件夹里的 6 张
    await page.click('.filter-bar__here')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 16)
    await page.click('.filter-bar__here')

    // 类目录：名称排序（英文数字在前、按数字大小，中文在后），不分组，出现“排序”条件
    await page.click('.side-nav__label:text-is("壁纸")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 5)
    await page.click('.filter-bar__btn')
    await page.click('.filter-bar__opt:has-text("名称")')
    await page.waitForFunction(() => document.querySelector('.tile .tile__name')?.textContent === 'a-9.jpg')
    expect(await tileNames(page)).toEqual(['a-9.jpg', 'a-10.jpg', 'b-2.jpg', '海边.jpg', '晚霞.jpg'])
    await expect(page.locator('.image-grid__head').count()).resolves.toBe(0)
    await expect(page.locator('.filter-chips__chip').innerText()).resolves.toContain('名称')
    await expect(page.locator('.filter-chips__num').textContent()).resolves.toBe('5')
    await shot(page, 'grid-category-light')

    // 深色
    await setAppearance(page, 'dark')
    await page.click('.side-nav__label:text-is("pics")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 22)
    await page.click('.tile:has-text("DSC09412.jpg")')
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.tile__pic')].slice(0, 6).every((i) => i.complete && i.naturalWidth > 0))
    await shot(page, 'grid-dark')
    await app.close()
  })
})
