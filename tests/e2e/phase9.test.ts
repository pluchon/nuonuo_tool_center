import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'

afterEach(async () => {
  await closeLeftoverApps()
})

const COLORS = ['#F6CDD8', '#D8CCEF', '#BFE3D6', '#EED3B3', '#BBD5EE']

// 生成一张纯色测试图
async function makeImage(file: string, i: number): Promise<void> {
  await sharp({ create: { width: 600 + i * 40, height: 420, channels: 3, background: COLORS[i] } })
    .jpeg({ quality: 90 })
    .toFile(file)
}

// 侧栏里某一行
function navRow(page: Page, label: string) {
  return page.locator('.side-nav__row').filter({ has: page.locator(`.side-nav__label:text-is("${label}")`) })
}

// 侧栏某一行的数量
async function waitCount(page: Page, label: string, value: string): Promise<void> {
  await page.waitForFunction(
    ([l, v]) =>
      [...document.querySelectorAll('.side-nav__row')].some(
        (e) => e.querySelector('.side-nav__label')?.textContent === l && e.querySelector('.side-nav__count')?.textContent === v
      ),
    [label, value] as const
  )
}

// 在侧栏输入行里输入名字并回车
async function typeName(page: Page, name: string): Promise<void> {
  await page.waitForSelector('.side-nav__edit-input')
  await page.fill('.side-nav__edit-input', name)
  await page.press('.side-nav__edit-input', 'Enter')
  await page.waitForSelector('.side-nav__edit-input', { state: 'detached' })
}

describe('第九阶段：目录管理', () => {
  it('目录树展开、子文件夹视图、新建 / 改名 / 删除类目录、拖到源目录、Ctrl+C、从图库移除', async () => {
    const dirs = freshCase('phase9-folders')
    const source = join(dirs.root, 'pics')
    mkdirSync(join(source, 'a', 'deep'), { recursive: true })
    mkdirSync(join(source, 'b'), { recursive: true })
    mkdirSync(dirs.library, { recursive: true })
    await makeImage(join(source, 'top.jpg'), 0)
    await makeImage(join(source, 'a', 'pa.jpg'), 1)
    await makeImage(join(source, 'a', 'deep', 'pd.jpg'), 2)
    await makeImage(join(source, 'b', 'pb.jpg'), 3)

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)

    // 展开 pics：子文件夹 a、b 和数量；再展开 a 看到 deep，带连线
    await navRow(page, 'pics').locator('.side-nav__caret').click()
    await waitCount(page, 'a', '2')
    await waitCount(page, 'b', '1')
    await navRow(page, 'a').locator('.side-nav__caret').click()
    await waitCount(page, 'deep', '1')
    await expect(page.locator('.side-nav__guide').count()).resolves.toBeGreaterThan(2)
    // 点 a：只看 a 里的图（含子目录）；“仅展示当前目录”开关出现
    await navRow(page, 'a').locator('.side-nav__item').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    await page.waitForSelector('.filter-bar__here')
    await shot(page, 'tree-light')

    // 类目录卡片的“+”：输入行，回车新建并进入
    await page.click('.side-nav__card[aria-label="类目录"] .side-nav__add')
    await typeName(page, '猫猫')
    await waitCount(page, '猫猫', '0')
    expect(existsSync(join(dirs.library, '猫猫'))).toBe(true)
    await expect(navRow(page, '猫猫').locator('.side-nav__item--on').count()).resolves.toBe(1)

    // 右键类目录：新建子目录（空着用默认名）
    await navRow(page, '猫猫').click({ button: 'right' })
    await page.waitForSelector('.folder-menu')
    await expect(page.locator('.folder-menu__item').allTextContents()).resolves.toEqual(['新建子目录', '重命名', '打开所在文件夹', '删除'])
    await shot(page, 'folder-menu-light')
    await page.click('.folder-menu__item:has-text("新建子目录")')
    await page.waitForSelector('.side-nav__edit-input')
    await shot(page, 'folder-new-light')
    await page.press('.side-nav__edit-input', 'Enter')
    await waitCount(page, '未命名的子目录', '0')
    expect(existsSync(join(dirs.library, '猫猫', '未命名的子目录'))).toBe(true)

    // 改名：猫猫 → 猫咪
    await navRow(page, '猫猫').click({ button: 'right' })
    await page.click('.folder-menu__item:has-text("重命名")')
    await typeName(page, '猫咪')
    await waitCount(page, '猫咪', '0')
    expect(existsSync(join(dirs.library, '猫咪', '未命名的子目录'))).toBe(true)

    // 拖一张图到源目录 b 上：确认后复制过去
    await navRow(page, 'pics').locator('.side-nav__item').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)
    await page.dragAndDrop('.tile:has-text("top.jpg")', '.side-nav__row:has(.side-nav__label:text-is("b"))')
    await page.waitForSelector('.confirm-dlg')
    await expect(page.locator('.confirm-dlg__title').textContent()).resolves.toBe('复制 1 张到「b」？')
    await shot(page, 'drop-confirm-light')
    await page.click('.confirm-dlg__ok')
    await page.waitForSelector('.app-toast:has-text("已复制 1 张到「b」")')
    expect(existsSync(join(source, 'b', 'top.jpg'))).toBe(true)
    await waitCount(page, 'b', '2')

    // Ctrl + C：复制图片
    await page.click('.tile:has-text("pa.jpg")')
    await page.keyboard.press('Control+c')
    await page.waitForSelector('.app-toast:has-text("已复制图片")')

    // 源目录顶层的右键菜单
    await navRow(page, 'pics').click({ button: 'right' })
    await expect(page.locator('.folder-menu__item').allTextContents()).resolves.toEqual(['新建子文件夹', '重新扫描', '打开所属源目录', '从图库移除'])
    await page.keyboard.press('Escape')
    await page.waitForSelector('.folder-menu', { state: 'detached' })

    // 删除类目录：整个文件夹进回收站
    await navRow(page, '猫咪').click({ button: 'right' })
    await page.click('.folder-menu__item:has-text("删除")')
    await expect(page.locator('.confirm-dlg__title').textContent()).resolves.toBe('删除类目录「猫咪」？')
    await page.click('.confirm-dlg__ok')
    await page.waitForSelector('.app-toast:has-text("已放进系统回收站")')
    expect(existsSync(join(dirs.library, '猫咪'))).toBe(false)
    expect(readdirSync(join(dirs.root, 'trash'))).toHaveLength(1)

    // 深色下的目录树
    await setAppearance(page, 'dark')
    await navRow(page, 'pics').locator('.side-nav__caret').click()
    await waitCount(page, 'a', '2')
    await shot(page, 'tree-dark')

    // 从图库移除源目录：磁盘文件不动
    await navRow(page, 'pics').click({ button: 'right' })
    await page.click('.folder-menu__item:has-text("从图库移除")')
    await expect(page.locator('.confirm-dlg__title').textContent()).resolves.toBe('从图库移除「pics」？')
    await page.click('.confirm-dlg__ok')
    await page.waitForSelector('.app-toast:has-text("已从图库移除「pics」")')
    await page.waitForSelector('.gallery__pick')
    expect(existsSync(join(source, 'top.jpg'))).toBe(true)
    await app.close()
  })
})
