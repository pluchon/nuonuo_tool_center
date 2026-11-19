import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'

afterEach(async () => {
  await closeLeftoverApps()
})

const COLORS = ['#F6CDD8', '#D8CCEF', '#BFE3D6', '#EED3B3', '#BBD5EE', '#E0C6E8', '#EEDFA3', '#CCD8E2']

// 生成一张带颜色的测试图（亮一点的噪点，每张内容不同）
async function makeImage(file: string, w: number, h: number, color: string, seed: number, png = false): Promise<void> {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: color } }).composite([
    {
      input: { create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.05 + (seed % 10) / 100 } } },
      blend: 'over'
    }
  ])
  await (png ? img.png() : img.jpeg({ quality: 90 })).toFile(file)
}

// 侧栏某一行的数量
async function countOf(page: Page, label: string): Promise<string | null> {
  return page.locator('.side-nav__item').filter({ has: page.locator(`.side-nav__label:text-is("${label}")`) }).locator('.side-nav__count').textContent()
}

// 等侧栏某一行变成某个数
async function waitCount(page: Page, label: string, value: string): Promise<void> {
  await page.waitForFunction(
    ([l, v]) =>
      [...document.querySelectorAll('.side-nav__item')].some(
        (e) => e.querySelector('.side-nav__label')?.textContent === l && e.querySelector('.side-nav__count')?.textContent === v
      ),
    [label, value] as const
  )
}

// 给当前这张图加一个标签（可以先选分类）
async function addTag(page: Page, name: string, category?: string): Promise<void> {
  if (category) {
    await page.click('.tag-editor__kind')
    await page.click(`.tag-editor__opt:has-text("${category}")`)
  }
  await page.fill('.tag-editor__input', name)
  await page.press('.tag-editor__input', 'Enter')
  await page.waitForSelector(`.tag-editor__tag:has-text("${name}")`)
}

describe('第五阶段：编辑', () => {
  it('改名、标签、R-18、批量编辑、标签 / 目录 / 更多筛选', async () => {
    const dirs = freshCase('phase5-edit')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    for (let i = 0; i < 8; i++) {
      await makeImage(join(source, `pic-${i}.${i === 7 ? 'png' : 'jpg'}`), 600 + i * 40, 420, COLORS[i], i, i === 7)
    }
    mkdirSync(join(dirs.library, '猫猫'), { recursive: true })
    await makeImage(join(dirs.library, '猫猫', 'cat.jpg'), 500, 500, '#FFFFFF', 9)

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8)

    // 改名：回车保存，网格和详情都更新
    await page.click('.tile:has-text("pic-0.jpg")')
    await page.fill('#nameInput', '甘雨-好椰表情包')
    await page.press('#nameInput', 'Enter')
    await page.waitForSelector('.tile .tile__name:text-is("甘雨-好椰表情包")')
    // 超过 15 个字：计数变红，不保存
    await page.fill('#nameInput', '一二三四五六七八九十一二三四五六')
    await expect(page.locator('.detail-panel__over').textContent()).resolves.toBe('最多 15 个字 · 16/15')
    await page.press('#nameInput', 'Enter')
    await page.click('.tile:has-text("pic-1.jpg")')
    await page.click('.tile:has-text("甘雨-好椰表情包")')
    await expect(page.locator('#nameInput').inputValue()).resolves.toBe('甘雨-好椰表情包')

    // 加标签：先选分类“角色”；侧栏计数跟着变
    await addTag(page, '甘雨', '角色')
    await waitCount(page, '全部图片', '1')
    await waitCount(page, '标签管理', '1')
    await expect(countOf(page, '还没打标签')).resolves.toBe('8')
    await addTag(page, '原神')
    await addTag(page, '表情包')
    await expect(page.locator('.tag-editor__tag').allTextContents()).resolves.toEqual(['甘雨 ✕', '原神 ✕', '表情包 ✕'])
    await expect(page.locator('.tag-editor__count').textContent()).resolves.toBe('3 / 5')
    await shot(page, 'edit-detail-light')

    // 另一张图：输入“甘”出候选，点它加上；已有标签沿用它的分类（分类按钮锁定）
    await page.click('.tile:has-text("pic-1.jpg")')
    await page.fill('.tag-editor__input', '甘')
    await page.waitForSelector('.tag-editor__sugg:has-text("甘雨")')
    await expect(page.locator('.tag-editor__sugg-count').first().textContent()).resolves.toBe('1 张')
    await page.click('.tag-editor__sugg:has-text("甘雨")')
    await page.waitForSelector('.tag-editor__tag:has-text("甘雨")')
    await page.fill('.tag-editor__input', '原神')
    // 选过的分类会一直沿用（照原型），所以原神、表情包也建在了“角色”下
    await expect(page.locator('.tag-editor__kind').innerText()).resolves.toContain('角色')
    await expect(page.locator('.tag-editor__kind--locked').count()).resolves.toBe(1)
    await page.fill('.tag-editor__input', '')
    for (const name of ['一', '二', '三', '四']) {
      await addTag(page, name)
    }
    await expect(page.locator('.tag-editor__input').getAttribute('placeholder')).resolves.toBe('已满 5 个，先删掉一个')
    // 移除一个
    await page.click('.tag-editor__tag:has-text("四") .tag-editor__x')
    await page.waitForFunction(() => document.querySelectorAll('.tag-editor__tag').length === 4)

    // R-18：网格里遮挡并打角标，侧栏计数
    await page.click('.detail-panel__switch')
    await waitCount(page, 'R-18 图', '1')
    await page.waitForSelector('.tile:has-text("pic-1.jpg") .tile__r18')
    await expect(page.locator('.detail-panel__switch').getAttribute('aria-checked')).resolves.toBe('true')

    // 批量：选 3 张，一起加“风景”，共同标签出现；再一起移除；全部标 R-18
    await page.click('.tile:has-text("pic-2.jpg")')
    await page.click('.tile:has-text("pic-3.jpg")', { modifiers: ['Control'] })
    await page.click('.tile:has-text("pic-4.jpg")', { modifiers: ['Control'] })
    await page.waitForSelector('.batch-panel')
    await expect(page.locator('.batch-panel__none').textContent()).resolves.toBe('没有共同标签')
    await page.fill('.batch-panel__input', '风景')
    await page.press('.batch-panel__input', 'Enter')
    await page.waitForSelector('.batch-panel__tag:has-text("风景")')
    await waitCount(page, '全部图片', '5')
    await shot(page, 'edit-batch-light')
    await page.click('.batch-panel__r18-btn--on')
    await waitCount(page, 'R-18 图', '4')
    await page.click('.batch-panel__tag:has-text("风景") .batch-panel__x')
    await page.waitForSelector('.batch-panel__none')
    await waitCount(page, '全部图片', '2')
    await page.keyboard.press('Escape')

    // 全部图片：按标签筛选（任一），出现条件标签
    await page.click('.side-nav__label:text-is("全部图片")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    await page.click('.filter-bar__btn:has-text("标签")')
    await expect(page.locator('.filter-bar__check .filter-bar__check-label').allTextContents()).resolves.toEqual(['甘雨', '原神', '表情包', '一', '二', '三'])
    await shot(page, 'filter-tags-light')
    await page.click('.filter-bar__check:has-text("表情包")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await expect(page.locator('.filter-chips__chip').first().innerText()).resolves.toContain('表情包')
    await page.click('.filter-chips__chip .filter-chips__x')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)

    // 更多筛选：格式 PNG → 没有；空状态写“没有符合条件的图片”
    await page.click('.filter-bar__btn:has-text("更多")')
    await page.click('.filter-bar__pill:text-is("PNG")')
    await page.waitForSelector('.gallery__empty')
    await expect(page.locator('.gallery__empty .gallery__text').textContent()).resolves.toBe('没有符合条件的图片')
    await page.click('.filter-bar__reset')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)

    // 目录筛选：列出源目录和类目录
    await page.click('.side-nav__label:text-is("还没打标签")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 7)
    await page.click('.filter-bar__btn:has-text("目录")')
    await expect(page.locator('.filter-bar__check .filter-bar__check-label').allTextContents()).resolves.toEqual(['pics', '猫猫'])
    await page.click('.filter-bar__check:has-text("猫猫")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await page.keyboard.press('Escape')

    // R-18 图：取消 R-18 后这张离开列表，选中移到下一张
    await page.click('.side-nav__label:text-is("R-18 图")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)
    const first = await page.locator('.tile--on .tile__name').textContent()
    await page.click('.detail-panel__switch')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3)
    await expect(page.locator('.tile--on').count()).resolves.toBe(1)
    expect(await page.locator('.tile--on .tile__name').textContent()).not.toBe(first)

    // 深色下的详情面板
    await setAppearance(page, 'dark')
    await page.click('.side-nav__label:text-is("pics")')
    await page.click('.tile:has-text("甘雨-好椰表情包")')
    await page.waitForSelector('.tag-editor__tag:has-text("甘雨")')
    await shot(page, 'edit-detail-dark')
    await app.close()
  })
})
