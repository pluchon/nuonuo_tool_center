import { existsSync, mkdirSync, readdirSync } from 'node:fs'
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

// 生成一张纯色测试图
async function makeImage(file: string, i: number): Promise<void> {
  await sharp({ create: { width: 600 + i * 40, height: 420, channels: 3, background: COLORS[i] } })
    .jpeg({ quality: 90 })
    .toFile(file)
}

// 对话框里的一行
function row(page: Page, label: string) {
  return page.locator('.transfer-dlg__row').filter({ has: page.locator(`.transfer-dlg__label:text-is("${label}")`) })
}

// 展开对话框里某个目录（已经展开的不动：打开时会自动展开到当前位置）
async function expand(page: Page, label: string): Promise<void> {
  const content = page.locator('.el-tree-node__content').filter({ has: page.locator(`.transfer-dlg__label:text-is("${label}")`) }).first()
  const icon = content.locator('.el-tree-node__expand-icon')
  if (!((await icon.getAttribute('class')) ?? '').includes('expanded')) {
    await icon.click()
  }
}

describe('第八阶段：移动和复制', () => {
  it('移动到子文件夹并撤销、复制到多个目录、已有副本、多选移动到类目录', async () => {
    const dirs = freshCase('phase8-transfer')
    const source = join(dirs.root, 'pics')
    mkdirSync(join(source, 'sub'), { recursive: true })
    mkdirSync(join(dirs.library, '猫猫'), { recursive: true })
    for (let i = 0; i < 4; i++) {
      await makeImage(join(source, `pic-${i}.jpg`), i)
    }

    const { app, page } = await launchApp(dirs)
    await page.click('.gallery__pick')
    await pickFolder(page, source)
    await page.click('.folder-pick__confirm')
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)

    // 移动到…：当前位置不能选；展开 pics 选 sub
    await page.click('.tile:has-text("pic-0.jpg")')
    await page.click('.detail-panel__act--main')
    await page.waitForSelector('.transfer-dlg')
    await expect(page.locator('.transfer-dlg__title').textContent()).resolves.toBe('移动到…')
    await expect(row(page, 'pics').locator('.transfer-dlg__note').textContent()).resolves.toBe('当前位置')
    await expect(row(page, '猫猫').locator('.transfer-dlg__note').textContent()).resolves.toBe('0 张')
    await expect(page.locator('.transfer-dlg__confirm').textContent()).resolves.toContain('先选一个目录')
    await expand(page, 'pics')
    await row(page, 'sub').click()
    await expect(page.locator('.transfer-dlg__confirm').textContent()).resolves.toContain('移动到「sub」')
    await shot(page, 'move-dialog-light')
    await page.click('.transfer-dlg__confirm')
    await page.waitForSelector('.app-toast:has-text("已移动 1 张到「sub」")')
    expect(existsSync(join(source, 'sub', 'pic-0.jpg'))).toBe(true)
    expect(existsSync(join(source, 'pic-0.jpg'))).toBe(false)
    // 撤销：挪回原处
    await page.click('.app-toast__btn--undo')
    await page.waitForFunction(() => !document.querySelector('.app-toast__btn--undo'))
    await expect.poll(() => existsSync(join(source, 'pic-0.jpg'))).toBe(true)
    expect(existsSync(join(source, 'sub', 'pic-0.jpg'))).toBe(false)

    // 复制到…：多选两个目录（勾选框是方的）
    await page.click('.tile:has-text("pic-1.jpg")')
    await page.click('.detail-panel__act:not(.detail-panel__act--main)')
    await page.waitForSelector('.transfer-dlg')
    await expect(page.locator('.transfer-dlg__title').textContent()).resolves.toBe('复制到…')
    await row(page, '猫猫').click()
    await expand(page, 'pics')
    await row(page, 'sub').click()
    await expect(page.locator('.transfer-dlg__confirm').textContent()).resolves.toContain('复制到 2 个目录')
    await shot(page, 'copy-dialog-light')
    await page.click('.transfer-dlg__confirm')
    await page.waitForSelector('.app-toast:has-text("已复制 1 张到 2 个目录")')
    expect(existsSync(join(dirs.library, '猫猫', 'pic-1.jpg'))).toBe(true)
    expect(existsSync(join(source, 'sub', 'pic-1.jpg'))).toBe(true)
    expect(existsSync(join(source, 'pic-1.jpg'))).toBe(true)
    // 侧栏类目录计数跟着变
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.side-nav__item')].some(
        (e) => e.querySelector('.side-nav__label')?.textContent === '猫猫' && e.querySelector('.side-nav__count')?.textContent === '1'
      )
    )

    // 再打开复制：已有副本的目录不能选，自动展开到副本所在位置
    await page.click('.detail-panel__act:not(.detail-panel__act--main)')
    await page.waitForSelector('.transfer-dlg__row:has-text("sub")')
    await expect(row(page, '猫猫').locator('.transfer-dlg__note').textContent()).resolves.toBe('已有副本')
    await expect(row(page, 'sub').locator('.transfer-dlg__note').textContent()).resolves.toBe('已有副本')
    await expect(row(page, 'pics').locator('.transfer-dlg__note').textContent()).resolves.toBe('当前位置')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.transfer-dlg', { state: 'detached' })

    // 多选两张移动到类目录“猫猫”
    await page.click('.tile:has-text("pic-2.jpg")')
    await page.click('.tile:has-text("pic-3.jpg")', { modifiers: ['Control'] })
    await page.click('.batch-panel__act--main')
    await row(page, '猫猫').click()
    await page.click('.transfer-dlg__confirm')
    await page.waitForSelector('.app-toast:has-text("已移动 2 张到「猫猫」")')
    expect(readdirSync(join(dirs.library, '猫猫')).sort()).toEqual(['pic-1.jpg', 'pic-2.jpg', 'pic-3.jpg'])

    // 深色下的对话框
    await setAppearance(page, 'dark')
    await page.click('.side-nav__label:text-is("pics")')
    await page.click('.tile:has-text("pic-0.jpg")')
    await page.click('.detail-panel__act--main')
    await page.waitForSelector('.transfer-dlg')
    // 刚点完就打开：也要按这张图的位置自动展开（sub 里有 pic-1 的副本，pics 有子文件夹）
    await page.waitForSelector('.transfer-dlg__row:has-text("sub")')
    await shot(page, 'move-dialog-dark')
    await page.keyboard.press('Escape')
    await app.close()
  })
})
