import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot, shotPrototype, SHOT_DIR } from './support/app'
import { compareShots } from './support/compare'

const diffRatios: Record<string, number> = {}

// 把系统的选择文件夹对话框换成直接返回指定目录（端到端测试里点不了系统对话框）
async function stubFolderPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, folder)
}

beforeAll(() => {
  mkdirSync(join(SHOT_DIR, 'diff'), { recursive: true })
})

afterEach(async () => {
  await closeLeftoverApps()
})

afterAll(() => {
  writeFileSync(join(SHOT_DIR, 'diff-ratios-phase2.json'), JSON.stringify(diffRatios, null, 2))
})

describe('第二阶段：按画布换主界面', () => {
  it('第一次打开：和画布“第一次打开”画板一致（浅色、深色）', async () => {
    const dirs = freshCase('phase2-first')
    const { app, page } = await launchApp(dirs)
    await page.waitForSelector('.gallery--welcome')

    const rows = await page.locator('.side-nav__item').evaluateAll((els) =>
      els.map((e) => [e.querySelector('.side-nav__label')?.textContent, e.querySelector('.side-nav__count')?.textContent])
    )
    expect(rows).toEqual([
      ['全部图片', '0'],
      ['还没打标签', '0'],
      ['最近导入', '0'],
      ['标签管理', '0'],
      ['R-18 图', '0']
    ])
    expect(await page.locator('.side-nav__hint').allTextContents()).toEqual(['还没有源目录', '还没有类目录'])
    expect((await page.locator('.status-footer').innerText()).split(/\s+/).filter(Boolean)).toEqual(['0', '张', '还没有扫描过', '重新扫描'])
    // 诺诺插画和品牌头像真的加载出来了
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>('.nono-art, .title-bar__brand')].every((i) => i.complete && i.naturalWidth > 0)
    )
    expect(await page.locator('.nono-art').getAttribute('alt')).toBe('诺诺抱着空白相册挥手')
    // 旧界面的东西都不在了
    expect(await page.locator('text=百炼').count()).toBe(0)
    expect(await page.locator('text=PostgreSQL').count()).toBe(0)

    const light = await shot(page, 'first-light')
    diffRatios['first-light'] = await compareShots(light, await shotPrototype('state-first'), join(SHOT_DIR, 'diff', 'first-light.png'))

    await setAppearance(page, 'dark')
    await page.waitForSelector('.gallery--welcome')
    const dark = await shot(page, 'first-dark')
    diffRatios['first-dark'] = await compareShots(dark, await shotPrototype('state-first-dark'), join(SHOT_DIR, 'diff', 'first-dark.png'))
    await app.close()
  })

  it('导入源目录后侧栏出现这个目录，主区显示空状态；类目录位置下的文件夹显示在类目录', async () => {
    const dirs = freshCase('phase2-import')
    const source = join(dirs.root, 'pics')
    mkdirSync(join(source, '2024 收藏'), { recursive: true })
    mkdirSync(join(dirs.library, '壁纸精选', '横屏'), { recursive: true })
    mkdirSync(join(dirs.library, '猫猫'), { recursive: true })

    const { app, page } = await launchApp(dirs)
    await page.waitForSelector('.gallery--welcome')
    expect(await page.locator('.side-nav__label').allTextContents()).toEqual([
      '全部图片',
      '还没打标签',
      '最近导入',
      '壁纸精选',
      '猫猫',
      '标签管理',
      'R-18 图'
    ])

    await stubFolderPicker(app, source)
    await page.click('.gallery__pick')
    await page.waitForSelector('.side-nav__label:text-is("pics")')
    await expect(page.locator('.gallery__text').textContent()).resolves.toBe('这里还没有图片')

    // 点源目录：选中态切到这一行
    await page.click('.side-nav__label:text-is("pics")')
    await expect(page.locator('.side-nav__item--on .side-nav__label').textContent()).resolves.toBe('pics')
    await shot(page, 'imported-light')

    // 再导入类目录所在的文件夹：拒绝并提示
    await stubFolderPicker(app, dirs.library)
    await page.click('.side-nav__add[aria-label="导入源目录"]')
    await expect(page.locator('.el-message').first().textContent()).resolves.toContain('和类目录所在的文件夹重叠')
    await app.close()
  })
})
