import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
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

describe('第七阶段：删除', () => {
  it('删除走确认，进回收站前可以撤销；多选删除；Delete 键；退出时把没执行的删除做完', async () => {
    const dirs = freshCase('phase7-delete')
    const source = join(dirs.root, 'pics')
    const trash = join(dirs.root, 'trash')
    mkdirSync(source, { recursive: true })
    for (let i = 0; i < 5; i++) {
      await makeImage(join(source, `pic-${i}.jpg`), i)
    }

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 5)

    // 单张删除：确认框默认聚焦“先不删”，Esc 取消
    await page.click('.tile:has-text("pic-0.jpg")')
    await page.click('.detail-panel__del')
    await page.waitForSelector('.confirm-dlg')
    await expect(page.locator('.confirm-dlg__title').textContent()).resolves.toBe('删除这张图？')
    await expect(page.evaluate(() => document.activeElement?.textContent)).resolves.toBe('先不删')
    await shot(page, 'delete-confirm-light')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.confirm-dlg', { state: 'detached' })
    await expect(page.locator('.tile').count()).resolves.toBe(5)

    // 确认删除：马上从网格消失，选中移到下一张；提示条带“撤销”
    await page.click('.detail-panel__del')
    await page.click('.confirm-dlg__ok')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)
    await page.waitForSelector('.app-toast:has-text("已放进系统回收站")')
    await expect(page.locator('.tile--on').count()).resolves.toBe(1)
    await shot(page, 'delete-toast-light')
    await page.click('.app-toast__btn--undo')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 5)
    expect(existsSync(join(source, 'pic-0.jpg'))).toBe(true)

    // 多选删除：批量面板的垃圾桶；等撤销窗口过去，文件真的离开源目录
    await page.click('.tile:has-text("pic-1.jpg")')
    await page.click('.tile:has-text("pic-2.jpg")', { modifiers: ['Control'] })
    await page.click('.batch-panel__bin')
    await expect(page.locator('.confirm-dlg__title').textContent()).resolves.toBe('删除这 2 张图？')
    await page.click('.confirm-dlg__ok')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3)
    await page.waitForSelector('.app-toast:has-text("2 张图已放进系统回收站")')
    await page.waitForFunction(() => !document.querySelector('.app-toast'), undefined, { timeout: 10_000 })
    await page.waitForTimeout(1500)
    expect(existsSync(join(source, 'pic-1.jpg'))).toBe(false)
    expect(existsSync(join(source, 'pic-2.jpg'))).toBe(false)
    expect(readdirSync(trash)).toHaveLength(2)

    // Delete 键删当前这张；不等撤销窗口直接退出：退出前做完
    await page.click('.tile:has-text("pic-3.jpg")')
    await page.keyboard.press('Delete')
    await page.click('.confirm-dlg__ok')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    await setAppearance(page, 'dark')
    await page.click('.side-nav__label:text-is("pics")')
    await page.click('.tile:has-text("pic-4.jpg")')
    await page.click('.detail-panel__del')
    await shot(page, 'delete-confirm-dark')
    await page.keyboard.press('Escape')
    await app.close()
    expect(existsSync(join(source, 'pic-3.jpg'))).toBe(false)
    expect(readdirSync(trash)).toHaveLength(3)

    // 重新打开：删掉的不会被扫描认回来
    const again = await launchApp(dirs)
    await again.page.click('.side-nav__label:text-is("pics")')
    await again.page.waitForFunction(() => document.querySelectorAll('.tile').length === 2, undefined, { timeout: 30_000 })
    await again.app.close()
  })
})
