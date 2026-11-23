import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder, stubFolderPick } from './support/picker'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import { updateSettings } from '../../src/main/services/settingsService'

// 生成的测试图数量：够扫上几秒，能看到进度横幅
const IMAGE_COUNT = 300

afterEach(async () => {
  await closeLeftoverApps()
})

// 生成一批互不相同的噪点图（分在三个子文件夹里），外加一个解不开的 HEIC
async function makeImages(dir: string): Promise<void> {
  for (const sub of ['2024 收藏', '2025 收藏', '表情包']) {
    mkdirSync(join(dir, sub), { recursive: true })
  }
  const subs = ['2024 收藏', '2025 收藏', '表情包']
  for (let i = 0; i < IMAGE_COUNT; i++) {
    await sharp({ create: { width: 640, height: 400 + (i % 5) * 40, channels: 3, background: '#7A63C9', noise: { type: 'gaussian', mean: 120 + (i % 50), sigma: 40 } } })
      .jpeg({ quality: 90 })
      .toFile(join(dir, subs[i % 3], `img-${String(i).padStart(3, '0')}.jpg`))
  }
  writeFileSync(join(dir, 'broken.heic'), Buffer.from('not a heic'))
}

// 侧栏某一行的数量文字
async function countOf(page: import('playwright').Page, label: string): Promise<string | null> {
  return page.locator('.side-nav__item').filter({ has: page.locator(`.side-nav__label:text-is("${label}")`) }).locator('.side-nav__count').textContent()
}

describe('第三阶段：导入和扫描', () => {
  it('导入源目录：对话框选文件夹 → 扫描横幅 → 完成提示；侧栏、底栏计数更新', async () => {
    const dirs = freshCase('phase3-scan')
    const source = join(dirs.root, 'pics')
    await makeImages(source)
    mkdirSync(join(dirs.library, '猫猫'), { recursive: true })
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#FFFFFF' } }).png().toFile(join(dirs.library, '猫猫', 'cat.png'))
    mkdirSync(dirs.data)
    await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
    try {
      await updateSettings({ autoScan: true })
    } finally {
      await closeDatabase()
    }

    const { app, page } = await launchApp(dirs)
    // 启动时自动扫描类目录，完成后更新时间，不弹提示。
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.side-nav__item')].some(
        (e) => e.querySelector('.side-nav__label')?.textContent === '猫猫' && e.querySelector('.side-nav__count')?.textContent === '1'
      )
    )
    await expect(page.locator('.status-footer').innerText()).resolves.toContain('刚刚扫描完成')
    await expect(page.locator('.app-toast').count()).resolves.toBe(0)

    await importFolder(app, page, source)

    await page.waitForSelector('.status-banner--scan')
    await expect(page.locator('.status-banner__title').textContent()).resolves.toBe('正在扫描「pics」')
    await expect(countOf(page, 'pics')).resolves.toBe('扫描中')
    await expect(page.locator('.status-footer').innerText()).resolves.toContain('正在扫描…')
    await page.waitForFunction(() => Number(document.querySelector('.status-banner__done')?.textContent?.replace(/,/g, '')) > 0)
    await shot(page, 'scanning-light')

    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await expect(page.locator('.app-toast').innerText()).resolves.toBe(`扫描完成，新增 ${IMAGE_COUNT + 1} 个文件`)
    await page.waitForSelector('.status-banner', { state: 'detached' })
    await expect(countOf(page, 'pics')).resolves.toBe(String(IMAGE_COUNT + 1))
    await expect(countOf(page, '还没打标签')).resolves.toBe(String(IMAGE_COUNT + 2))
    // 扫完紧接着在本地分级：“本地分级中 N/M”这颗胶囊不比
    const words = (await page.locator('.status-footer').innerText()).split(/\s+/).filter(Boolean)
    const at = words.indexOf('本地分级中')
    const footer = at >= 0 ? [...words.slice(0, at), ...words.slice(at + 2)] : words
    // 队列状态取决于本地分级进度和凭证配置，扫描计数始终来自实际文件。
    expect(['看图队列', '看图待配置']).toContain(footer[0])
    expect(footer[1]).toMatch(/^\d+$/)
    expect(footer.slice(2)).toEqual(['一键整理', (IMAGE_COUNT + 2).toLocaleString('zh-CN'), '张', '刚刚扫描完成', '重新扫描'])
    await shot(page, 'scanned-light')

    // 重新扫描：文件都没变，很快结束，计数不变
    await page.waitForSelector('.app-toast', { state: 'detached' })
    await page.click('.status-footer__scan')
    await page.waitForSelector('.app-toast')
    await expect(page.locator('.app-toast').innerText()).resolves.toBe('扫描完成，无新增文件')
    await expect(countOf(page, 'pics')).resolves.toBe(String(IMAGE_COUNT + 1))
    await app.close()

    // 源目录被挪走：重启后自动扫描不动记录，侧栏标“找不到”，进入后横幅可以重新选择位置
    const moved = join(dirs.root, 'pics-moved')
    renameSync(source, moved)
    const second = await launchApp(dirs)
    const p2 = second.page
    await p2.waitForSelector('.side-nav__label:text-is("pics")')
    await expect(countOf(p2, 'pics')).resolves.toBe('找不到')
    await p2.click('.side-nav__label:text-is("pics")')
    await p2.waitForSelector('.status-banner--offline')
    await expect(p2.locator('.status-banner__title').textContent()).resolves.toBe(`找不到 ${source}`)
    await shot(p2, 'offline-light')
    await setAppearance(p2, 'dark')
    await p2.click('.side-nav__label:text-is("pics")')
    await p2.waitForSelector('.status-banner--offline')
    await shot(p2, 'offline-dark')

    await stubFolderPick(second.app, moved)
    await p2.click('.status-banner__btn')
    // 文件都没变，改位置后的扫描几乎立刻结束，“已改到”的提示会马上被“扫描完成”替换
    await p2.waitForSelector('.app-toast:has-text("扫描完成，无新增文件")', { timeout: 90_000 })
    const overview = await p2.evaluate(() => window.api.library.getOverview())
    expect(overview.ok && overview.data.sources[0]).toMatchObject({ path: moved, offline: false })
    await expect(countOf(p2, 'pics')).resolves.toBe(String(IMAGE_COUNT + 1))
    await expect(p2.locator('.status-banner').count()).resolves.toBe(0)
    await second.app.close()
  })
})
