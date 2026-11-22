import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot, type CaseDirs } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
  delete process.env.LTM_R18_THRESHOLD
})

// 生成几张渐变测试图（不用任何真实图片）
async function makeImages(dir: string, n: number): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const colors = ['#BBD5EE', '#F6CDD8', '#BFE3D6', '#EED3B3']
  for (let i = 0; i < n; i++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="100%" height="100%" fill="${colors[i % colors.length]}"/><circle cx="300" cy="250" r="120" fill="#ffffff" fill-opacity="0.6"/></svg>`
    await sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toFile(join(dir, `pic-${i}.jpg`))
  }
}

// 等日志里出现某一行（本地分级在后台跑，界面上只有 R-18 的变化）
async function waitForLog(dirs: CaseDirs, text: string, timeout = 180_000): Promise<string> {
  const file = join(dirs.data, 'logs', 'main.log')
  const start = Date.now()
  for (;;) {
    const log = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const line = log.split('\n').find((l) => l.includes(text))
    if (line) {
      return line
    }
    if (Date.now() - start > timeout) {
      throw new Error(`等不到日志：${text}\n${log.slice(-2000)}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

function r18Count(page: Page): Promise<string | null> {
  return page.locator('.side-nav__item:has(.side-nav__label:text-is("R-18 图")) .side-nav__count').textContent()
}

describe('本地分级', () => {
  it('扫描完在后台判一遍：普通图不打 R-18', async () => {
    const dirs = freshCase('rating')
    const source = join(dirs.root, 'pics')
    await makeImages(source, 3)
    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    const line = await waitForLog(dirs, '本地分级：判了')
    expect(line).toContain('判了 3 张，其中 0 张判为 R-18')
    expect(await r18Count(page)).toBe('0')
    await app.close()
  }, 300_000)

  it('判为 R-18 的直接打上、标“诺诺判的”；手动关掉后不再改回来', async () => {
    // 测试用：阈值调到 0，所有图都会被判成 R-18（只能往下调）
    process.env.LTM_R18_THRESHOLD = '0'
    const dirs = freshCase('rating-r18')
    const source = join(dirs.root, 'pics')
    await makeImages(source, 2)
    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    await waitForLog(dirs, '其中 2 张判为 R-18')
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('.side-nav__item')].find((e) => e.querySelector('.side-nav__label')?.textContent === 'R-18 图')
      return row?.querySelector('.side-nav__count')?.textContent === '2'
    })

    await page.locator('.side-nav__label:text-is("R-18 图")').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    await page.click('.tile >> nth=0')
    await page.waitForSelector('.detail-panel__by-model')
    for (const mode of ['light', 'dark'] as const) {
      await setAppearance(page, mode)
      await page.locator('.side-nav__label:text-is("R-18 图")').click()
      await page.click('.tile >> nth=0')
      await page.waitForSelector('.detail-panel__by-model')
      // 等详情面板滑出来的动画放完
      await page.waitForTimeout(800)
      await shot(page, `rating-${mode}-by-model`)
    }

    // 手动关掉：离开 R-18 视图，“诺诺判的”没了；重启后也不会被重新判回来
    await page.click('.detail-panel__switch')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await app.close()
    const again = await launchApp(dirs)
    await again.page.waitForFunction(() => {
      const row = [...document.querySelectorAll('.side-nav__item')].find((e) => e.querySelector('.side-nav__label')?.textContent === 'R-18 图')
      return row?.querySelector('.side-nav__count')?.textContent === '1'
    })
    await again.page.waitForTimeout(3000)
    expect(await r18Count(again.page)).toBe('1')
    await again.app.close()
  }, 300_000)
})
