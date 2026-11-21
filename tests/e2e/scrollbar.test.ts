import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance } from './support/app'
import { importFolder } from './support/picker'

// 网格自绘滚动条：显示、拖动、点轨道、滚轮、月份气泡、不盖住卡片；截图在 test-output/scrollbar/
sharp.cache(false)
const OUT = resolve('test-output/scrollbar')
const COLORS = ['#F6CDD8', '#BBD5EE', '#BFE3D6', '#E8D5B9', '#D7C4F0', '#C4E0D6', '#F2E3B3', '#E3F2B3']

afterEach(async () => {
  await closeLeftoverApps()
})

// 网格滚动位置
function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector<HTMLElement>('.image-grid')!.scrollTop)
}

describe('网格滚动条', () => {
  it('图多时出现，可拖、可点轨道、可滚轮，拖动时显示月份', async () => {
    const dirs = freshCase('scrollbar')
    const src = join(dirs.root, 'many')
    mkdirSync(dirs.library, { recursive: true })
    mkdirSync(src, { recursive: true })
    mkdirSync(OUT, { recursive: true })
    // 每张颜色都略有不同（内容相同的图会按哈希合并成一张）
    for (let i = 0; i < 160; i++) {
      const w = [320, 240, 400, 200][i % 4]
      const rgb = Buffer.from(COLORS[i % COLORS.length].slice(1), 'hex')
      const background = { r: rgb[0], g: rgb[1], b: Math.max(0, rgb[2] - i) }
      await sharp({ create: { width: w, height: 240, channels: 3, background } })
        .jpeg()
        .toFile(join(src, `pic-${String(i).padStart(3, '0')}.jpg`))
    }

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, src)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 120_000 })
    await page.waitForSelector('.grid-scroll', { state: 'visible' })
    const thumb = page.locator('.grid-scroll__thumb')

    // 滚动条占着右侧窄边，不盖住任何卡片（等详情面板滑入、网格按新宽度排好）
    await page.mouse.move(5, 400)
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    await page.waitForTimeout(300)
    const overlap = await page.evaluate(() => {
      const bar = document.querySelector('.grid-scroll')!.getBoundingClientRect()
      return [...document.querySelectorAll('.tile')].some((t) => t.getBoundingClientRect().right > bar.left + 0.5)
    })
    expect(overlap).toBe(false)
    await page.mouse.move(5, 400)
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(OUT, 'idle-light.png') })

    // 悬停变粗
    await thumb.hover()
    await expect.poll(() => thumb.evaluate((el) => el.getBoundingClientRect().width)).toBe(10)

    // 拖滑块往下：网格跟着滚，气泡显示月份
    const box = (await thumb.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 220, { steps: 8 })
    expect(await scrollTop(page)).toBeGreaterThan(200)
    await expect.poll(() => page.locator('.grid-scroll__bubble--on').textContent()).toMatch(/\d{4} 年 \d+ 月/)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUT, 'drag-light.png') })
    await page.mouse.up()

    // 点轨道底部：平滑滚到底
    const bar = (await page.locator('.grid-scroll').boundingBox())!
    await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height - 8)
    // 平滑滚动本身要 1 秒多（expect.poll 默认只等 1 秒）
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const g = document.querySelector<HTMLElement>('.image-grid')!
            return g.scrollHeight - g.clientHeight - g.scrollTop
          }),
        { timeout: 5000 }
      )
      .toBeLessThan(2)
    await expect
      .poll(
        async () => {
          const t = (await thumb.boundingBox())!
          return Math.round(bar.y + bar.height - (t.y + t.height))
        },
        { timeout: 5000 }
      )
      .toBe(6)

    // 在滚动条上滚滚轮也能滚网格
    const before = await scrollTop(page)
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
    await page.mouse.wheel(0, -600)
    await expect.poll(() => scrollTop(page), { timeout: 5000 }).toBeLessThan(before - 100)

    // 深色下拖动的样子
    await setAppearance(page, 'dark')
    // 重载后默认在“全部图片”（只显示打过标签的），回到“还没打标签”
    await page.locator('.side-nav__item').filter({ hasText: '还没打标签' }).first().click()
    await page.waitForSelector('.grid-scroll', { state: 'visible' })
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    const b2 = (await thumb.boundingBox())!
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2)
    await page.mouse.down()
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2 + 260, { steps: 6 })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUT, 'drag-dark.png') })
    await page.mouse.up()

    await app.close()
  })
})
