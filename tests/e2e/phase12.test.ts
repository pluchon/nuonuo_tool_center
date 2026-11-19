import { copyFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

const COLORS = ['#F6CDD8', '#D8CCEF', '#BFE3D6', '#EED3B3', '#BBD5EE']

async function makeImage(file: string, i: number): Promise<void> {
  await sharp({ create: { width: 500 + i * 30, height: 360, channels: 3, background: COLORS[i] } })
    .jpeg({ quality: 90 })
    .toFile(file)
}

// 网格里的图片名
function tileNames(page: Page): Promise<string[]> {
  return page.locator('.tile').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? '').sort())
}

describe('第十二阶段：实时监听', () => {
  it('外部新增、删除、改名自动反映到网格，标签跟着改名的文件走；关掉监听后不再自动更新', async () => {
    const dirs = freshCase('phase12-watch')
    const source = join(dirs.root, 'pics')
    const outside = join(dirs.root, 'outside')
    mkdirSync(source, { recursive: true })
    mkdirSync(outside, { recursive: true })
    mkdirSync(dirs.library, { recursive: true })
    await makeImage(join(source, 'a.jpg'), 0)
    await makeImage(join(source, 'b.jpg'), 1)
    for (let i = 2; i < 5; i++) {
      await makeImage(join(outside, `n${i}.jpg`), i)
    }

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.click('.side-nav__label:text-is("pics")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)

    // 给 b 打个标签，改名后标签还在
    await page.click('.tile:has-text("b.jpg")')
    await page.fill('.tag-editor__input', '猫猫')
    await page.press('.tag-editor__input', 'Enter')
    await page.waitForSelector('.tag-editor__tag:has-text("猫猫")')

    // 导入时的“扫描完成”先消失
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { state: 'detached', timeout: 15_000 })
    // 外部复制进来一张（含子文件夹里一张）：不用点任何东西，网格自己多出来
    copyFileSync(join(outside, 'n2.jpg'), join(source, 'n2.jpg'))
    mkdirSync(join(source, 'sub'))
    copyFileSync(join(outside, 'n3.jpg'), join(source, 'sub', 'n3.jpg'))
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4, undefined, { timeout: 20_000 })
    await expect(tileNames(page)).resolves.toEqual(['a.jpg', 'b.jpg', 'n2.jpg', 'n3.jpg'])
    // 自动扫描不弹“扫描完成”
    await expect(page.locator('.app-toast:has-text("扫描完成")').count()).resolves.toBe(0)

    // 外部改名：按内容接回，标签不丢
    renameSync(join(source, 'b.jpg'), join(source, 'b-renamed.jpg'))
    await page.waitForFunction(() => !!document.querySelector('.tile[aria-label="b-renamed.jpg"]'), undefined, { timeout: 20_000 })
    await page.click('.tile:has-text("b-renamed.jpg")')
    await page.waitForSelector('.tag-editor__tag:has-text("猫猫")')

    // 外部删除：从网格里去掉
    unlinkSync(join(source, 'a.jpg'))
    await page.waitForFunction(() => !document.querySelector('.tile[aria-label="a.jpg"]'), undefined, { timeout: 20_000 })

    // 关掉“实时监听文件变化”：再放进来的图不会自动出现
    await page.click('.title-bar__gear')
    await page.click('.set-dlg__tab:has-text("图库")')
    const sw = page.locator('.set-dlg__row').filter({ hasText: '实时监听文件变化' }).locator('.set-dlg__switch')
    await sw.click()
    await expect(sw.getAttribute('aria-checked')).resolves.toBe('false')
    await page.keyboard.press('Escape')
    const before = await page.locator('.tile').count()
    copyFileSync(join(outside, 'n4.jpg'), join(source, 'n4.jpg'))
    // 再在外面删掉一张；监听关着，网格不动
    unlinkSync(join(source, 'n2.jpg'))
    await page.waitForTimeout(5000)
    await expect(page.locator('.tile').count()).resolves.toBe(before)

    // 点底栏“重新扫描”：新放进来的出现，外面删掉的从列表里去掉
    await page.click('.status-footer__scan')
    await page.waitForFunction(() => !!document.querySelector('.tile[aria-label="n4.jpg"]') && !document.querySelector('.tile[aria-label="n2.jpg"]'), undefined, {
      timeout: 30_000
    })

    // 再打开：重建监听（之前漏掉的要等下次扫描），新的变化又能自动反映
    await page.click('.title-bar__gear')
    await sw.click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    renameSync(join(source, 'n4.jpg'), join(source, 'n4-new.jpg'))
    await page.waitForFunction(() => !!document.querySelector('.tile[aria-label="n4-new.jpg"]'), undefined, { timeout: 20_000 })
    await app.close()
  })
})
