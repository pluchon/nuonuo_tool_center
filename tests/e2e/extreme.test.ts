import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { importFolder } from './support/picker'

// 测试进程里 sharp 读过的文件会被它的缓存占着（Windows 上删不掉），关掉缓存
sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 一张纯色 JPG
async function jpg(path: string, w: number, h: number, color = '#C9B8E8'): Promise<void> {
  await sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toFile(path)
}

// 等页面上所有动画做完
function settle(page: Page): Promise<unknown> {
  return page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
}

// 侧栏某一行
function navItem(page: Page, label: string) {
  return page.locator('.side-nav__item').filter({ hasText: label }).first()
}

describe('极端情况', () => {
  it('怪文件、超大图、深目录、长名字、快速操作、缩略图丢失、源目录被删都不出错', async () => {
    const dirs = freshCase('extreme')
    const src = join(dirs.root, 'weird')
    mkdirSync(dirs.library, { recursive: true })
    mkdirSync(src, { recursive: true })

    // 能显示的图（10 张内容各不相同；dup-b 和 dup-a 内容相同，只算一张）
    await jpg(join(src, 'huge.jpg'), 12000, 8000, '#F6CDD8')
    await jpg(join(src, 'pano.jpg'), 10000, 100, '#BBD5EE')
    await jpg(join(src, 'tiny.jpg'), 1, 1, '#BFE3D6')
    await jpg(join(src, 'UPPER.JPG'), 640, 480, '#E8D5B9')
    await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 120, g: 80, b: 200, alpha: 0.4 } } })
      .png()
      .toFile(join(src, 'really-png.jpg'))
    await jpg(join(src, `${'很长的名字🐱 '.repeat(8).trim()}.jpg`), 400, 300, '#D7C4F0')
    await jpg(join(src, "a&b#c%d'e [1] (2).jpg"), 320, 240, '#C4E0D6')
    await jpg(join(src, 'dup-a.jpg'), 500, 500, '#ABCDEF')
    await jpg(join(src, 'dup-b.jpg'), 500, 500, '#ABCDEF')
    let deep = src
    for (let i = 1; i <= 12; i++) {
      deep = join(deep, `层${i}`)
    }
    mkdirSync(deep, { recursive: true })
    await jpg(join(deep, 'deep.jpg'), 300, 200, '#F2E3B3')
    await jpg(join(src, 'spaces   in   name.jpg'), 200, 200, '#E3F2B3')
    // 显示不了的：空文件、坏文件
    writeFileSync(join(src, 'empty.jpg'), Buffer.alloc(0))
    writeFileSync(join(src, 'broken.png'), Buffer.from('this is not a png at all, just text pretending'))

    const { app, page } = await launchApp(dirs)
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text())
      }
    })
    page.on('pageerror', (e) => errors.push(String(e)))

    await importFolder(app, page, src)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 120_000 })
    await navItem(page, '还没打标签').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length > 0)
    await settle(page)
    const tiles = await page.locator('.tile').count()
    // 11 个文件能显示（两张同内容的算一张 → 10），加上空文件、坏文件各一张“无法预览”
    const names = await page.locator('.tile').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    expect(names).toEqual(expect.arrayContaining(['deep.jpg', 'UPPER.JPG', 'really-png.jpg', 'empty.jpg', 'broken.png', "a&b#c%d'e [1] (2).jpg"]))
    expect(tiles).toBe(12)
    await expect(page.locator('.tile__bad:has-text("无法预览")').count()).resolves.toBe(2)

    // 大图：快速翻完所有图（按住 → 连按），再在超大图上放大缩小
    await page.locator('.tile').first().click()
    await page.keyboard.press('Enter')
    await page.waitForSelector('.viewer')
    for (let i = 0; i < tiles * 2; i++) {
      await page.keyboard.press('ArrowRight')
    }
    await page.locator('.side-nav__item').first().count()
    await page.keyboard.press('Escape')
    await page.waitForSelector('.viewer', { state: 'detached' })
    await page.click('.tile[aria-label="huge.jpg"]')
    await page.keyboard.press(' ')
    await page.waitForSelector('.viewer')
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('.viewer__pic')
      return !!img && img.complete && img.naturalWidth === 12000
    }, undefined, { timeout: 30_000 })
    await page.keyboard.press('1')
    await expect(page.locator('.viewer__zoom').textContent()).resolves.not.toBe('100%')
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('-')
    }
    await page.keyboard.press('0')
    await expect(page.locator('.viewer__zoom').textContent()).resolves.toBe('100%')
    await page.keyboard.press(' ')
    await page.waitForSelector('.viewer', { state: 'detached' })

    // 搜索：特殊字符、超长字符串不报错，空结果显示空状态
    for (const q of ['%', '_', '\\', "'", '[', '🐱', 'x'.repeat(500)]) {
      await page.keyboard.press('Control+f')
      await page.keyboard.insertText(q)
      await page.waitForTimeout(350)
    }
    await page.fill('.filter-bar__input', '🐱')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await page.fill('.filter-bar__input', '')
    await page.waitForFunction((n) => document.querySelectorAll('.tile').length === n, tiles)

    // 快速来回切明暗、主题色
    for (let i = 0; i < 6; i++) {
      await page.evaluate((dark) => window.api.settings.update({ appearance: dark ? 'dark' : 'light' }), i % 2 === 0)
    }
    await page.evaluate(() => window.api.settings.update({ appearance: 'light' }))

    // 缩略图被手动删光：页面不卡住（读不到马上 404），重新扫描后补回来
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.clearCache())
    const thumbsDir = join(dirs.data, 'thumbs')
    for (const f of readdirSync(thumbsDir)) {
      rmSync(join(thumbsDir, f))
    }
    await page.reload()
    await page.waitForSelector('.app-root')
    await navItem(page, '还没打标签').click()
    await page.waitForFunction((n) => document.querySelectorAll('.tile').length === n, tiles)
    await page.click('.status-footer__scan')
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 120_000 })
    // 10 张内容不同的图各一张缩略图（空文件、坏文件没有）
    expect(readdirSync(thumbsDir).length).toBe(10)

    // 连点几次重新扫描：排队，不报错
    for (let i = 0; i < 3; i++) {
      await page.locator('.status-footer__scan').click().catch(() => undefined)
    }
    await page.waitForFunction(() => !!document.querySelector('.status-footer__scan'), undefined, { timeout: 120_000 })

    // 源目录整个被删掉：侧栏标“找不到”，不崩
    rmSync(src, { recursive: true, force: true })
    await page.waitForFunction(() => [...document.querySelectorAll('.side-nav__item')].some((e) => e.textContent?.includes('找不到')), undefined, {
      timeout: 30_000
    })

    expect(errors.filter((e) => !e.includes('ERR_FILE_NOT_FOUND') && !e.includes('404'))).toEqual([])
    await app.close()
  })
})
