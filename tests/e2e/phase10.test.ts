import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'

afterEach(async () => {
  await closeLeftoverApps()
})

// 生成一张渐变测试图（看得出平移、翻转）
async function makeImage(file: string, width: number, height: number): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#F6CDD8"/><stop offset="1" stop-color="#BBD5EE"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width / 4}" cy="${height / 3}" r="${Math.min(width, height) / 6}" fill="#D8CCEF"/></svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file)
}

// 大图标题
function title(page: Page): Promise<string | null> {
  return page.locator('.viewer__title').textContent()
}

// 当前缩放百分比
function zoomText(page: Page): Promise<string | null> {
  return page.locator('.viewer__zoom').textContent()
}

// 图片整张都在舞台里（允许 1px 误差）
async function fullyInside(page: Page): Promise<boolean> {
  // 等打开大图的过渡动画做完再量（动画里卡片还在缩放）
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
  const stage = await page.locator('.viewer__stage').boundingBox()
  const pic = await page.locator('.viewer__pic').boundingBox()
  if (!stage || !pic) {
    return false
  }
  return pic.x >= stage.x - 1 && pic.y >= stage.y - 1 && pic.x + pic.width <= stage.x + stage.width + 1 && pic.y + pic.height <= stage.y + stage.height + 1
}

// 等原图读完
async function waitOriginal(page: Page, width: number): Promise<void> {
  await page.waitForFunction((w) => {
    const img = document.querySelector<HTMLImageElement>('.viewer__pic')
    return !!img && img.complete && img.naturalWidth === w && img.src.startsWith('ltm://file/')
  }, width)
}

describe('第十阶段：大图查看', () => {
  it('双击 / Enter / 点预览打开，缩放、拖动、旋转、翻转、上下张、原图读不到退回缩略图', async () => {
    const dirs = freshCase('phase10-viewer')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    mkdirSync(dirs.library, { recursive: true })
    await makeImage(join(source, 'wide.jpg'), 3000, 400)
    await makeImage(join(source, 'tall.jpg'), 400, 2400)
    await makeImage(join(source, 'gone.jpg'), 800, 600)

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3)
    // 扫完就把一张原图删掉（缩略图还在），后面看它时原图读不到；先关掉实时监听，不然它会被自动从列表里去掉
    await page.evaluate(() => window.api.settings.update({ watchChanges: false }))
    unlinkSync(join(source, 'gone.jpg'))

    // 双击全景图：原图整张显示在舞台里，100%
    await page.dblclick('.tile:has-text("wide.jpg")')
    await page.waitForSelector('.viewer')
    await expect(title(page)).resolves.toBe('wide.jpg')
    await waitOriginal(page, 3000)
    await expect(zoomText(page)).resolves.toBe('100%')
    await expect(fullyInside(page)).resolves.toBe(true)
    await shot(page, 'viewer-light')

    // 放大按钮、Ctrl + 滚轮
    await page.click('.viewer__round[aria-label="放大"]')
    await expect(zoomText(page)).resolves.toBe('125%')
    const pan = page.locator('.viewer__pan')
    const box = (await pan.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect(zoomText(page)).resolves.toBe('135%')

    // 放大后按住拖动：图跟着走
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 4 })
    await page.mouse.up()
    // 滚轮缩放以鼠标为中心，鼠标离舞台中心有零点几像素时会先带一点偏移，这里按近似比
    const moved = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((await page.locator('.viewer__pic').getAttribute('style')) ?? '')
    expect(Number(moved?.[1])).toBeCloseTo(80, 0)
    expect(Number(moved?.[2])).toBeCloseTo(30, 0)
    // 拖到遮罩外松手不会关掉
    await expect(page.locator('.viewer').count()).resolves.toBe(1)

    // 缩回 100% 以下自动回中
    await page.click('.viewer__round[aria-label="缩小"]')
    await page.click('.viewer__round[aria-label="缩小"]')
    await expect(zoomText(page)).resolves.toBe('85%')
    await expect(page.locator('.viewer__pic').getAttribute('style')).resolves.toContain('translate(0px, 0px)')

    // 原始大小：一个像素对一个像素
    await page.click('.viewer__pill:has-text("原始大小")')
    await page.waitForTimeout(300)
    const actual = (await page.locator('.viewer__pic').boundingBox())!
    expect(Math.abs(actual.width - 3000)).toBeLessThan(4)
    await page.click('.viewer__pill:has-text("适应窗口")')
    await expect(zoomText(page)).resolves.toBe('100%')

    // 旋转、翻转、还原
    await page.click('.viewer__round[aria-label="向右旋转"]')
    await page.click('.viewer__round[aria-label="水平翻转"]')
    await expect(page.locator('.viewer__pic').getAttribute('style')).resolves.toContain('rotate(90deg)')
    await expect(page.locator('.viewer__round[aria-label="水平翻转"]').getAttribute('aria-pressed')).resolves.toBe('true')
    await page.waitForTimeout(300)
    // 转过来以后仍然整张放得下
    await expect(fullyInside(page)).resolves.toBe(true)
    await shot(page, 'viewer-rotated-light')
    await page.click('.viewer__pill:has-text("还原")')
    await expect(page.locator('.viewer__pic').getAttribute('style')).resolves.toContain('rotate(0deg)')

    // ← / →：按网格顺序换图，首尾相接
    const names = await page.locator('.tile').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    const at = names.indexOf('wide.jpg')
    await page.keyboard.press('ArrowRight')
    await expect(title(page)).resolves.toBe(names[(at + 1) % 3])
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(title(page)).resolves.toBe(names[(at + 2) % 3])
    await page.click('.viewer__nav--next')
    await expect(title(page)).resolves.toBe('wide.jpg')

    // Esc 关闭，详情面板跟着停在最后看的那张
    await page.keyboard.press('Escape')
    await page.waitForSelector('.viewer', { state: 'detached' })
    await expect(page.locator('.tile[aria-pressed="true"]').getAttribute('aria-label')).resolves.toBe('wide.jpg')

    // 长图：Enter 打开，整张显示
    await page.click('.tile:has-text("tall.jpg")')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.viewer')
    await expect(title(page)).resolves.toBe('tall.jpg')
    await waitOriginal(page, 400)
    await expect(fullyInside(page)).resolves.toBe(true)
    // 点遮罩关闭
    await page.mouse.click(4, 4)
    await page.waitForSelector('.viewer', { state: 'detached' })

    // 协议只认图库里的文件 id
    const status = await page.evaluate(async () => {
      const load = (src: string): Promise<string> =>
        new Promise((done) => {
          const img = new Image()
          img.onload = () => done('ok')
          img.onerror = () => done('error')
          img.src = src
        })
      return [await load('ltm://file/999999'), await load('ltm://file/..%5C..%5Cx'), await load('ltm://file/1')]
    })
    // 不存在的 id、路径都读不到；图库里的第一个文件能读
    expect(status).toEqual(['error', 'error', 'ok'])

    // 原图被删了：退回缩略图并说明；点详情预览打开
    await page.click('.tile:has-text("gone.jpg")')
    await page.waitForSelector('.detail-panel__zoom')
    await page.click('.detail-panel__zoom')
    await page.waitForSelector('.viewer__note:has-text("原图读不到，先显示缩略图")')
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.viewer__pic')?.src.startsWith('ltm://thumb/'))
    await expect(fullyInside(page)).resolves.toBe(true)
    await page.keyboard.press('Escape')

    // 深色：舞台是深衬底
    await setAppearance(page, 'dark')
    await page.click('.side-nav__label:text-is("pics")')
    await page.dblclick('.tile:has-text("wide.jpg")')
    await waitOriginal(page, 3000)
    await expect(page.locator('.viewer__stage').evaluate((e) => getComputedStyle(e).backgroundColor)).resolves.toBe('rgb(20, 17, 24)')
    await shot(page, 'viewer-dark')
    await page.keyboard.press('Escape')
    await app.close()
  })
})
