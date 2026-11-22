import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 画一张带字的测试图（不用任何真实图片）
async function makeImage(file: string, text: string, bg: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="100%" height="100%" fill="${bg}"/><circle cx="700" cy="160" r="90" fill="#F2B84B"/><text x="60" y="330" font-size="80" font-family="Microsoft YaHei" fill="#333">${text}</text></svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file)
}

describe('一键整理', () => {
  it('本地分级进度条、分级中一键整理点不了；看完图出方案（真实调用）、批方案、按目录分组审、一组全部采用后复制进类目录', async () => {
    const dirs = freshCase('organize')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await makeImage(join(source, 'meme1.jpg'), '好椰', '#F6E7C8')
    await makeImage(join(source, 'meme2.jpg'), '晚安', '#CFE3F5')
    await makeImage(join(source, 'meme3.jpg'), '早上好', '#E2F4EE')

    const { app, page } = await launchApp(dirs)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // 记下本地分级推过来的进度
    await page.evaluate(() => {
      const w = window as unknown as { __rating: Array<{ running: boolean; done: number; total: number }> }
      w.__rating = []
      window.api.rating.onProgress((p) => w.__rating.push(p))
    })
    await importFolder(app, page, source)
    // 分级在跑时底栏有“本地分级中…”和进度条，判完收起
    await page.waitForSelector('.rating-pill', { timeout: 60_000 })
    await shot(page, 'organize-light-rating')
    // 分级没判完：一键整理变灰，点了只弹提示条，不开确认框
    await page.waitForSelector('.organize--waiting')
    // 分级只要一两秒：确认还是灰的和点击放在同一刻，免得点下去时刚好判完
    const clickedWhileWaiting = await page.evaluate(() => {
      const b = document.querySelector<HTMLButtonElement>('.organize--waiting')
      b?.click()
      return b !== null
    })
    if (clickedWhileWaiting) {
      await page.waitForSelector('.app-toast:has-text("本地分级判完才能整理")')
      await expect(page.locator('.org-dlg').count()).resolves.toBe(0)
    }
    await page.waitForSelector('.rating-pill', { state: 'detached', timeout: 120_000 })
    await expect(page.locator('.organize--waiting').count()).resolves.toBe(0)
    const progress = await page.evaluate(() => (window as unknown as { __rating: Array<{ running: boolean; done: number; total: number }> }).__rating)
    expect(progress.some((p) => p.running && p.total === 3)).toBe(true)
    expect(progress[progress.length - 1]).toMatchObject({ running: false, done: 3 })

    // 新图自动看完（真实看图），“AI 建议”有 3 张
    await page.waitForFunction(
      () => {
        const row = [...document.querySelectorAll('.side-nav__item')].find((e) => e.querySelector('.side-nav__label')?.textContent === 'AI 建议')
        return row?.querySelector('.side-nav__count')?.textContent === '3'
      },
      null,
      { timeout: 240_000 }
    )

    // 一键整理：图都看过了，确认后直接出方案（真实调用）
    await page.click('.organize')
    await page.waitForSelector('.org-dlg__stat:has-text("待看")')
    // 一排“待看 / token / 花费”各一行；没有副标题、提示和脚注
    await expect(page.locator('.org-dlg__stat span').allTextContents()).resolves.toEqual(['待看', 'token', '花费'])
    await expect(page.locator('.org-dlg__sub, .org-dlg__note, .org-dlg__foot').count()).resolves.toBe(0)
    await expect(page.locator('.org-dlg__stat b').first().textContent()).resolves.toBe('0')
    await page.waitForTimeout(300)
    await shot(page, 'organize-light-confirm')
    await page.click('.org-dlg__go')
    await page.waitForSelector('.org-dlg__card--plan', { timeout: 150_000 })
    await page.waitForTimeout(400)
    const failed = await page.locator('.org-dlg__error-text').textContent().catch(() => null)
    expect(failed).toBeNull()
    expect(await page.locator('.org-dlg__folder').count()).toBeGreaterThan(0)
    // 方案弹窗只有标题，不放说明
    await expect(page.locator('.org-dlg__sub').count()).resolves.toBe(0)
    await shot(page, 'organize-light-plan')
    // 换成深色：页面重新加载，方案待确认会再弹出来
    await setAppearance(page, 'dark')
    await page.waitForSelector('.org-dlg__card--plan')
    await page.waitForTimeout(400)
    await shot(page, 'organize-dark-plan')
    await page.click('.org-dlg__go')
    await page.waitForSelector('.org-dlg', { state: 'detached' })
    await page.waitForSelector('.app-toast:has-text("在“AI 建议”里慢慢审"), .app-toast:has-text("没有能分进")')

    // AI 建议视图：按目标类目录分组，组头一起采用
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.waitForSelector('.image-grid__head--dir')
    await page.click('.tile >> nth=0')
    await page.waitForSelector('.sugg__row:has-text("放进")')
    await page.waitForTimeout(500)
    await shot(page, 'organize-dark-review')
    await setAppearance(page, 'light')
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.waitForSelector('.image-grid__head--dir')
    await page.waitForTimeout(500)
    await shot(page, 'organize-light-review')
    const folder = (await page.locator('.image-grid__head--dir .image-grid__title').first().textContent())!.trim()
    const n = await page.locator('.image-grid__group').first().locator('.tile').count()
    await page.click('.image-grid__accept >> nth=0')
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.image-grid__head--dir .image-grid__title')].every((e) => e.textContent?.trim() !== name),
      folder,
      { timeout: 60_000 }
    )
    expect(existsSync(join(dirs.library, folder))).toBe(true)
    expect(readdirSync(join(dirs.library, folder))).toHaveLength(n)
    // 原图还在源目录
    expect(readdirSync(source)).toHaveLength(3)
    expect(errors).toEqual([])
    await app.close()
  }, 600_000)
})
