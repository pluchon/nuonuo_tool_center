import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'
import { bailianRequests, launchWithMockBailian } from './support/mockBailian'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 画一张带字的测试图（不用任何真实图片）
async function makeImage(file: string, text: string, bg: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="100%" height="100%" fill="${bg}"/><circle cx="700" cy="160" r="90" fill="#F2B84B"/><text x="60" y="330" font-size="80" font-family="Microsoft YaHei" fill="#333">${text}</text></svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file)
}

function navCount(page: Page, label: string): Promise<string | null> {
  return page.locator(`.side-nav__item:has(.side-nav__label:text-is("${label}")) .side-nav__count`).textContent()
}

describe('诺诺看图和 AI 建议', () => {
  it('一张图片被百炼拦截后移出队列并待复核，另一张仍会生成建议', async () => {
    const dirs = freshCase('look-moderation')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await makeImage(join(source, 'a.jpg'), '示例一', '#CFE3F5')
    await makeImage(join(source, 'b.jpg'), '示例二', '#E2F4EE')

    const { app, page } = await launchWithMockBailian(dirs, 1)
    await importFolder(app, page, source)
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    expect((await bailianRequests(app)).filter((route) => route === 'responses')).toHaveLength(2)
    expect(await page.evaluate(() => window.api.look.state())).toMatchObject({ ok: true, data: { count: 0, rows: [] } })
    const suggestions = await page.evaluate(() => window.api.gallery.list({ view: 'ai', sort: 'new' }))
    if (!suggestions.ok) throw new Error(suggestions.message)
    const rejected = suggestions.data.items.filter((image) => image.isR18)
    const accepted = suggestions.data.items.filter((image) => !image.isR18)
    expect(rejected).toHaveLength(1)
    expect(accepted).toHaveLength(1)
    await page.locator(`.tile[aria-label="${rejected[0].name}"]`).click()
    await page.getByText('云端内容审核未通过', { exact: true }).waitFor()
    await page.getByRole('button', { name: '保留 R-18' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await page.locator('.tile').click()
    await page.getByRole('button', { name: '全部采用' }).waitFor()
    const embeddings = async () => (await bailianRequests(app)).filter((route) => route === 'multimodal-embedding').length
    expect(await embeddings()).toBe(0)
    await page.getByRole('button', { name: '全部采用' }).click()
    await page.locator('.gallery__empty').waitFor()
    const category = join(dirs.library, '已归档')
    mkdirSync(category, { recursive: true })
    for (const filename of ['a.jpg', 'b.jpg']) {
      copyFileSync(join(source, filename), join(category, filename))
    }
    expect((await page.evaluate(() => window.api.scan.start(null))).ok).toBe(true)
    const policy = () => page.evaluate(() => window.api.ai.policy())
    await expect.poll(policy).toMatchObject({ ok: true, data: { dailyLimit: 0, pendingImages: 1 } })
    expect(await embeddings()).toBe(0)
    expect((await page.evaluate(() => window.api.ai.embeddingLimit(2))).ok).toBe(true)
    await expect.poll(embeddings, { timeout: 10_000 }).toBe(1)
    await page.waitForTimeout(700)
    expect(await embeddings()).toBe(1)
    await app.close()
  })

  it('新图过了本地分级自动排队并生成建议，支持逐项采用、全部采用和导入外部建议', async () => {
    const dirs = freshCase('look')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await makeImage(join(source, 'meme.jpg'), '好椰', '#F6E7C8')
    await makeImage(join(source, '12345678_p0.jpg'), '晚安', '#CFE3F5')
    await makeImage(join(source, 'third.jpg'), '早上好', '#E2F4EE')

    const { app, page } = await launchWithMockBailian(dirs)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text())
      }
    })
    await importFolder(app, page, source)

    // 本地分级和看图处理完后，三张图片进入 AI 建议。
    await page.waitForFunction(
      () => {
        const row = [...document.querySelectorAll('.side-nav__item')].find((e) => e.querySelector('.side-nav__label')?.textContent === 'AI 建议')
        return row?.querySelector('.side-nav__count')?.textContent === '3'
      },
      null,
      { timeout: 60_000 }
    )
    expect((await bailianRequests(app)).filter((route) => route === 'responses')).toHaveLength(3)
    expect(await page.locator('.look__badge').first().textContent()).toBe('0')
    await page.click('.look__pill')
    await page.waitForSelector('.look__empty')
    await page.waitForTimeout(300)
    await shot(page, 'look-light-queue-empty')
    await page.keyboard.press('Escape')

    // AI 建议视图：建议卡；逐项不要、采用
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3)
    await page.click('.tile >> nth=0')
    await page.waitForSelector('.sugg__row')
    await page.waitForTimeout(800)
    await shot(page, 'look-light-suggest')
    const rows = await page.locator('.sugg__row').count()
    expect(rows).toBeGreaterThan(0)
    await page.click('.sugg__no >> nth=0')
    await page.waitForFunction((n) => document.querySelectorAll('.sugg__row').length === n - 1 || document.querySelectorAll('.tile').length === 2, rows)

    // Pixiv 文件名那张：出处直接来自文件名
    const pixiv = page.locator('.tile:has-text("12345678_p0")')
    if ((await pixiv.count()) > 0) {
      await pixiv.click()
      await page.waitForSelector('.sugg__row')
      await expect(page.locator('.sugg__row:has-text("pixiv.net/artworks/12345678")').count()).resolves.toBe(1)
    }

    // 全部采用：三张都处理完，列表空了，详情面板收起
    for (let i = 0; i < 6 && (await page.locator('.tile').count()) > 0; i++) {
      await page.click('.tile >> nth=0')
      await page.waitForSelector('.sugg__all')
      await page.click('.sugg__all')
      await page.waitForTimeout(600)
    }
    await page.waitForSelector('.gallery__empty:has-text("没有要确认的建议")')
    expect(await navCount(page, 'AI 建议')).toBe('0')

    // 其他 AI 辅助整理：复制提示词、贴回结果、交给诺诺整理
    await page.locator('.side-nav__label:text-is("pics")').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3)
    await page.click('.tile >> nth=0')
    await page.click('.assist__copy')
    await page.waitForSelector('.app-toast:has-text("已复制提示词")')
    const prompt = await page.evaluate(() => navigator.clipboard.readText())
    expect(prompt).toContain('## 输出格式')
    await page.fill('.assist__input', '没有代码块')
    await page.waitForSelector('.assist__bad')
    await page.fill('.assist__input', '```json\n{"name": "外部起的名字", "tags": ["测试标签"], "source": ""}\n```')
    await page.waitForSelector('.assist__count:has-text("识别到 2 条")')
    await page.waitForTimeout(300)
    await shot(page, 'look-light-assist')
    await page.click('.assist__hand')
    await page.waitForSelector('.app-toast:has-text("诺诺整理好了")')
    expect(await navCount(page, 'AI 建议')).toBe('1')

    // 深色下看一遍建议卡和队列卡
    await setAppearance(page, 'dark')
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await page.click('.tile >> nth=0')
    await page.waitForSelector('.sugg__row')
    await page.waitForTimeout(800)
    await shot(page, 'look-dark-suggest')
    await page.click('.look__pill')
    await page.waitForSelector('.look__card')
    await page.waitForTimeout(300)
    await shot(page, 'look-dark-queue-empty')
    expect(errors).toEqual([])
    await app.close()
  }, 400_000)
})
