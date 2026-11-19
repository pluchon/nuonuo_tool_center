import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { pickFolder } from './support/picker'

afterEach(async () => {
  await closeLeftoverApps()
})

const COLORS = ['#F6CDD8', '#D8CCEF', '#BFE3D6', '#EED3B3', '#BBD5EE']

// 生成一张纯色测试图（每张颜色和尺寸不同，内容哈希不同）
async function makeImage(file: string, i: number): Promise<void> {
  await sharp({ create: { width: 600 + i * 40, height: 420, channels: 3, background: COLORS[i] } })
    .jpeg({ quality: 90 })
    .toFile(file)
}

// 在图库里给当前这张图加一个标签（可先选分类）
async function addTag(page: Page, name: string, category?: string): Promise<void> {
  if (category) {
    await page.click('.tag-editor__kind')
    await page.click(`.tag-editor__opt:has-text("${category}")`)
  }
  await page.fill('.tag-editor__input', name)
  await page.press('.tag-editor__input', 'Enter')
  await page.waitForSelector(`.tag-editor__tag:has-text("${name}")`)
}

// 标签管理页里某个分类卡片下的标签名
async function tagsIn(page: Page, category: string): Promise<string[]> {
  return page.evaluate((c) => {
    const card = [...document.querySelectorAll('.tags-view__card')].find((e) => e.querySelector('.tags-view__kind')?.textContent?.trim() === c)
    return [...(card?.querySelectorAll('.tags-view__tag') ?? [])].map((e) => e.firstChild?.textContent?.trim() ?? '')
  }, category)
}

// 点标签管理里的某个标签
async function pickTag(page: Page, name: string): Promise<void> {
  await page.click(`.tags-view__tag:has-text("${name}")`)
  await page.waitForFunction((n) => (document.querySelector('#tagNameInput') as HTMLInputElement | null)?.value === n, name)
}

describe('第六阶段：标签管理', () => {
  it('分组列表、改名 / 分类 / 别名、合并、查看图片、新建、删除、分类对话框、换色', async () => {
    const dirs = freshCase('phase6-tags')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    for (let i = 0; i < 3; i++) {
      await makeImage(join(source, `pic-${i}.jpg`), i)
    }
    // 文件名超过 15 个字的图：没起过名字时不该显示“最多 15 个字”
    await makeImage(join(source, '1750851496332_p0.jpg'), 3)

    const { app, page } = await launchApp(dirs)
    await page.click('.gallery__pick')
    await pickFolder(page, source)
    await page.click('.folder-pick__confirm')
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)

    await page.click('.tile:has-text("1750851496332")')
    await page.waitForFunction(() => (document.querySelector('#nameInput') as HTMLInputElement | null)?.placeholder === '1750851496332_p0.jpg')
    await expect(page.locator('.detail-panel__over').count()).resolves.toBe(0)
    await expect(page.locator('#nameInput').inputValue()).resolves.toBe('')

    // 准备标签：甘雨（角色）2 张、原神 1 张、Genshin 1 张
    await page.click('.tile:has-text("pic-0.jpg")')
    await addTag(page, '甘雨', '角色')
    await addTag(page, '原神', '作品')
    await page.click('.tile:has-text("pic-1.jpg")')
    await addTag(page, '甘雨')
    await page.click('.tile:has-text("pic-2.jpg")')
    await addTag(page, 'Genshin', '作品')

    // 进入标签管理：侧栏高亮，按分类分组，默认选中图片最多的甘雨
    await page.click('.side-nav__label:text-is("标签管理")')
    await page.waitForSelector('.tags-view')
    await expect(page.locator('.side-nav__item--on .side-nav__label').textContent()).resolves.toBe('标签管理')
    await expect(tagsIn(page, '角色')).resolves.toEqual(['甘雨'])
    await expect(tagsIn(page, '作品')).resolves.toEqual(['原神', 'Genshin'])
    await expect(page.locator('#tagNameInput').inputValue()).resolves.toBe('甘雨')
    await expect(page.locator('.tag-panel__pill').first().innerText()).resolves.toContain('2 张')
    await expect(page.locator('.tags-view__tag--on').innerText()).resolves.toContain('甘雨')
    // 没改动时保存按钮不可点
    await expect(page.locator('.tag-panel__save').isDisabled()).resolves.toBe(true)
    await shot(page, 'tags-light')

    // 改别名和分类后保存：甘雨移到“作品”卡片
    await page.fill('.tag-panel__alias-input', 'ganyu')
    await page.press('.tag-panel__alias-input', 'Enter')
    await page.fill('.tag-panel__alias-input', '椰羊')
    await page.press('.tag-panel__alias-input', 'Enter')
    await page.click('.tag-panel__kind')
    await page.click('.tag-panel__opt:has-text("作品")')
    await page.click('.tag-panel__save')
    await page.waitForFunction(() => document.querySelectorAll('.tag-panel__alias').length === 2 && !!document.querySelector('.tag-panel__save:disabled'))
    await expect(tagsIn(page, '作品')).resolves.toEqual(['甘雨', '原神', 'Genshin'])
    await expect(tagsIn(page, '角色')).resolves.toEqual([])
    await expect(page.locator('.tags-view__empty').first().textContent()).resolves.toBe('没有匹配的标签')

    // 搜索按别名
    await page.fill('.tags-view__input', '椰')
    await expect(tagsIn(page, '作品')).resolves.toEqual(['甘雨'])
    await page.fill('.tags-view__input', '')

    // 名字超过 15 个字：计数变红，不能保存
    await page.fill('#tagNameInput', '一二三四五六七八九十一二三四五六')
    await expect(page.locator('.tag-panel__len').textContent()).resolves.toBe('最多 15 个字 · 16/15')
    await expect(page.locator('.tag-panel__save').isDisabled()).resolves.toBe(true)
    await page.fill('#tagNameInput', '甘雨')

    // 原神：把 Genshin 合并进来
    await pickTag(page, '原神')
    await page.click('.tag-panel__mode:has-text("合并进来")')
    await page.click('.tag-panel__merge')
    await page.click('.tag-panel__mopt:has-text("Genshin")')
    await page.click('.tag-panel__mode:has-text("合并进来")')
    await expect(page.locator('.tag-panel__preview').innerText()).resolves.toContain('Genshin → 原神')
    await expect(page.locator('.tag-panel__save').textContent()).resolves.toBe('保存并合并')
    await shot(page, 'tags-merge-light')
    await page.click('.tag-panel__save')
    await page.waitForFunction(() => ![...document.querySelectorAll('.tags-view__tag')].some((e) => e.textContent?.includes('Genshin')))
    await expect(tagsIn(page, '作品')).resolves.toEqual(['甘雨', '原神'])
    await expect(page.locator('.tag-panel__alias').allTextContents()).resolves.toEqual(['Genshin ✕'])
    await expect(page.locator('.tag-panel__pill').first().innerText()).resolves.toContain('2 张')

    // “2 张 ›”：回到全部图片，带上原神的筛选
    await page.click('.tag-panel__pill:has-text("张")')
    await page.waitForSelector('.gallery')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    await expect(page.locator('.filter-chips__chip').first().innerText()).resolves.toContain('原神')
    await expect(page.locator('.side-nav__item--on .side-nav__label').textContent()).resolves.toBe('全部图片')

    // 新建标签：放进第一个分类“角色”
    await page.click('.side-nav__label:text-is("标签管理")')
    await page.click('.tags-view__new')
    await expect(page.locator('.tag-panel__badge').textContent()).resolves.toBe('新建中')
    await page.fill('#tagNameInput', '风景')
    await page.fill('.tag-panel__alias-input', 'scenery')
    await page.press('.tag-panel__alias-input', 'Enter')
    await shot(page, 'tags-create-light')
    await page.click('.tag-panel__save')
    await page.waitForFunction(() => (document.querySelector('#tagNameInput') as HTMLInputElement).value === '风景' && !document.querySelector('.tag-panel__badge'))
    await expect(tagsIn(page, '角色')).resolves.toEqual(['风景'])

    // 删除风景：确认框默认聚焦“先不删”
    await page.click('.tag-panel__pill--del')
    await page.waitForSelector('.confirm-dlg')
    await expect(page.locator('.confirm-dlg__title').textContent()).resolves.toBe('删除标签「风景」？')
    await expect(page.evaluate(() => document.activeElement?.textContent)).resolves.toBe('先不删')
    await shot(page, 'tags-delete-light')
    await page.click('.confirm-dlg__ok')
    await page.waitForSelector('.confirm-dlg', { state: 'detached' })
    await expect(tagsIn(page, '角色')).resolves.toEqual([])

    // 分类对话框：新增、改名、删除；有标签在用的不能删
    await page.click('.tags-view__kinds')
    await page.waitForSelector('.kind-dlg')
    await page.click('.kind-dlg__add')
    await page.waitForFunction(() => [...document.querySelectorAll('.kind-dlg__input')].some((e) => (e as HTMLInputElement).value === '新分类'))
    await page.keyboard.type('游戏')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.tags-view__kind:text-is("游戏")')
    await shot(page, 'tags-kinds-light')
    const workRow = page.locator('.kind-dlg__row').filter({ has: page.locator('.kind-dlg__count:has-text("2 个标签")') })
    await expect(workRow.locator('.kind-dlg__del--off').count()).resolves.toBe(1)
    const gameRow = page.locator('.kind-dlg__row').last()
    await gameRow.locator('.kind-dlg__del').click()
    await page.waitForFunction(() => ![...document.querySelectorAll('.tags-view__kind')].some((e) => e.textContent?.trim() === '游戏'))
    await page.keyboard.press('Escape')
    await page.waitForSelector('.kind-dlg', { state: 'detached' })

    // 换色：作品换成粉色（第 1 个色块）
    const workCard = page.locator('.tags-view__card').filter({ has: page.locator('.tags-view__kind:text-is("作品")') })
    await workCard.locator('.tags-view__pal').click()
    await shot(page, 'tags-palette-light')
    await workCard.locator('.tags-view__swatch').first().click()
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll('.tags-view__card')].find((e) => e.querySelector('.tags-view__kind')?.textContent?.trim() === '作品')
      return card?.querySelector('.tags-view__dot')?.getAttribute('style')?.includes('D86F95')
    })

    // 深色
    await setAppearance(page, 'dark')
    await page.click('.side-nav__label:text-is("标签管理")')
    await page.waitForSelector('.tags-view__tag--on')
    await shot(page, 'tags-dark')
    await app.close()
  })
})
