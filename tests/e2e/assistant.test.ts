import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 生成一张纯色渐变测试图
async function makeImage(file: string, w: number, h: number, a: string, b: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toFile(file)
}

function nav(page: Page, label: string) {
  return page.locator(`.side-nav__label:text-is("${label}")`)
}

async function addTag(page: Page, name: string): Promise<void> {
  await page.fill('.tag-editor__input', name)
  await page.press('.tag-editor__input', 'Enter')
  await page.waitForSelector(`.tag-editor__tag:has-text("${name}")`)
}

// 问一句，等回复出来（或出错横幅）
async function askAndWait(page: Page, text: string): Promise<void> {
  const before = await page.locator('.assistant__reply').count()
  await page.fill('.assistant__input', text)
  await page.press('.assistant__input', 'Enter')
  await page.waitForFunction(
    (n) => document.querySelectorAll('.assistant__reply').length > n || !!document.querySelector('.assistant__banner'),
    before,
    { timeout: 120_000 }
  )
}

describe('诺诺助手', () => {
  it('本地路由、对话循环、对话记录、大图，浅色和深色截图；没有凭证时整页提示', async () => {
    const dirs = freshCase('assistant')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    const specs: Array<[number, number, string, string]> = [
      [1600, 900, '#BBD5EE', '#BFE3D6'],
      [900, 1600, '#F6CDD8', '#D8CCEF'],
      [1200, 800, '#EED3B3', '#F6CDD8'],
      [800, 1200, '#BFE3D6', '#4A86C2']
    ]
    for (const [i, [w, h, a, b]] of specs.entries()) {
      await makeImage(join(source, `pic-${i}.jpg`), w, h, a, b)
    }

    const { app, page } = await launchApp(dirs)
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text())
      }
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })

    await nav(page, 'pics').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)
    for (const [n, tags] of [
      [0, ['风景', '天空']],
      [1, ['猫']],
      [2, ['风景']],
      [3, ['猫']]
    ] as const) {
      await page.click(`.tile >> nth=${n}`)
      for (const t of tags) {
        await addTag(page, t)
      }
    }
    await page.click('.tile >> nth=1')
    await page.click('.detail-panel__switch')
    await page.waitForSelector('.detail-panel__r18--on')

    for (const mode of ['light', 'dark'] as const) {
      await setAppearance(page, mode)
      const s = (name: string): Promise<string> => shot(page, `assistant-${mode}-${name}`)
      await nav(page, '诺诺助手').click()
      await page.waitForSelector('.assistant__welcome')
      await expect(page.locator('.assistant__idea').count()).resolves.toBeGreaterThan(0)
      await s('01-new')

      // 本地能完整对上：不调模型
      await askAndWait(page, '找猫的图')
      await expect(page.locator('.assistant__how').last().textContent()).resolves.toContain('找到 1 张')
      await expect(page.locator('.assistant__reply').last().locator('.assistant__pic').count()).resolves.toBe(1)

      // 打开 R-18 再问一次：R-18 图出现在后面，带角标
      await page.click('.assistant__r18')
      await askAndWait(page, '猫')
      await expect(page.locator('.assistant__reply').last().locator('.assistant__pic-r18').count()).resolves.toBe(1)
      await page.click('.assistant__r18')

      // 交给模型：真实调用云端
      await askAndWait(page, '有没有适合当电脑壁纸的风景照，横的那种')
      await s('02-chat')
      await expect(page.locator('.assistant__banner').count()).resolves.toBe(0)

      // 单击选中，双击看大图，Esc 关掉
      const pic = page.locator('.assistant__reply').last().locator('.assistant__pic').first()
      if ((await pic.count()) > 0) {
        await pic.click()
        await page.waitForSelector('.assistant__pic--on')
        await pic.dblclick()
        await page.waitForSelector('.viewer__pic')
        await page.waitForFunction(() => (document.querySelector('.viewer__pic') as HTMLImageElement | null)?.complete === true)
        await page.waitForTimeout(400)
        await s('03-viewer')
        await page.keyboard.press('Escape')
        await page.waitForSelector('.viewer', { state: 'detached' })
      }

      // 范围下拉、对话记录、右键菜单
      await page.click('.assistant__dir')
      await page.waitForSelector('.assistant__dirs')
      // 等弹出动画放完再截图
      await page.waitForTimeout(300)
      await s('04-dir-menu')
      await page.click('.assistant__mi:has-text("pics")')
      await expect(page.locator('.assistant__dir-label').textContent()).resolves.toBe('pics')
      await page.click('.assistant__round[aria-label="对话记录"]')
      await page.waitForSelector('.assistant__hist-row')
      await page.click('.assistant__hist-row >> nth=0', { button: 'right' })
      await page.waitForSelector('.assistant__ctx')
      await page.waitForTimeout(300)
      await s('05-history')
      // 第二项是“置顶”或“取消置顶”：点一下，图钉数量要变
      const pinsBefore = await page.locator('.assistant__pin').count()
      await page.click('.assistant__ctx .assistant__mi >> nth=1')
      await page.waitForFunction((n) => document.querySelectorAll('.assistant__pin').length !== n, pinsBefore)
      await page.keyboard.press('Escape')

      // 新对话
      await page.click('.assistant__round[aria-label="新对话"]')
      await page.waitForSelector('.assistant__welcome')
    }
    expect(errors).toEqual([])
    await app.close()

    // 没有凭证：整页显示“诺诺还没连上云端”
    const saved = process.env.DASHSCOPE_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    try {
      const second = await launchApp(dirs)
      await nav(second.page, '诺诺助手').click()
      await second.page.waitForSelector('.assistant__nokey')
      await shot(second.page, 'assistant-dark-06-nokey')
      await second.app.close()
    } finally {
      if (saved !== undefined) {
        process.env.DASHSCOPE_API_KEY = saved
      }
    }
  }, 600_000)
})
