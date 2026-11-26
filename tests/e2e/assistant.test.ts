import { copyFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'
import { launchWithMockBailian } from './support/mockBailian'

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

    const { app, page } = await launchWithMockBailian(dirs)
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text())
      }
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await nav(page, 'AI 建议').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4)
    const reviewed = await page.evaluate(async () => {
      const list = await window.api.gallery.list({ view: 'ai', sort: 'new' })
      if (!list.ok) throw new Error(list.message)
      return window.api.suggestion.decideMany(list.data.items.map((item) => item.imageId), false)
    })
    expect(reviewed.ok).toBe(true)

    // 助手只在类目录检索；保留源图，验证归档副本继承同一张图片的标签。
    const category = join(dirs.library, '测试归档')
    mkdirSync(category, { recursive: true })
    for (const i of specs.keys()) {
      const filename = `pic-${i}.jpg`
      copyFileSync(join(source, filename), join(category, filename))
    }
    const scan = await page.evaluate(() => window.api.scan.start(null))
    expect(scan.ok).toBe(true)
    await expect.poll(() => page.evaluate(() => window.api.scan.getState()), { timeout: 60_000 }).toMatchObject({
      ok: true, data: { progress: null, last: { stopped: false, rootName: null } }
    })
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
      await page.locator('.assistant__idea').first().waitFor()
      await s('01-new')

      // 云端就绪时即使按标签查询也经由模型检索并自然作答，记录缓存命中率。
      await askAndWait(page, '找标签为猫的图')
      await expect(page.locator('.assistant__reply').last().locator('.assistant__step').last().textContent()).resolves.toContain('1 张')
      expect(await page.locator('.assistant__cache').last().innerText()).toBe('缓存命中率 60%')
      await expect(page.locator('.assistant__reply').last().locator('.assistant__pic').count()).resolves.toBe(1)

      // 受保护结果在悬停、单击和历史会话中都保持模糊，双击才加载原图。
      await page.click('.assistant__r18')
      await askAndWait(page, '找标签为猫的图')
      const results = page.locator('.assistant__reply').last()
      expect(await results.locator('.assistant__text').innerText()).toBeTruthy()
      const cardGap = await results.evaluate((el) => el.querySelector('.assistant__pic')!.getBoundingClientRect().top -
        el.querySelector('.assistant__text')!.getBoundingClientRect().bottom)
      expect(cardGap).toBeGreaterThanOrEqual(0)
      expect(cardGap).toBeLessThan(16)
      const protectedCard = results.locator('.assistant__pic:has(.assistant__pic-r18)')
      const normalCard = results.locator('.assistant__pic:not(:has(.assistant__pic-r18))')
      const thumb = protectedCard.locator('.assistant__thumbnail')
      await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      expect(await protectedCard.getAttribute('draggable')).toBe('true')
      const externalDrag = await protectedCard.evaluate(el => {
        const dataTransfer = new DataTransfer()
        const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, altKey: true, dataTransfer })
        el.dispatchEvent(event)
        return { cancelled: event.defaultPrevented, types: dataTransfer.types }
      })
      expect(externalDrag).toEqual({ cancelled: true, types: [] })
      const placement = await protectedCard.evaluate((el) => {
        const card = el.getBoundingClientRect()
        const lock = el.querySelector('.assistant__pic-r18')!.getBoundingClientRect()
        return { right: card.right - lock.right, bottom: card.bottom - lock.bottom }
      })
      expect(placement.right).toBeLessThan(12)
      expect(placement.bottom).toBeLessThan(12)
      await protectedCard.hover()
      await protectedCard.click()
      expect(await thumb.evaluate((img) => getComputedStyle(img).filter)).toContain('blur(')
      expect(await page.locator('.viewer').count()).toBe(0)
      const normalName = await normalCard.locator('.assistant__pic-name').textContent()
      await normalCard.dblclick()
      await page.locator('.viewer__pic').waitFor()
      await page.keyboard.press('ArrowRight')
      expect(await page.locator('.viewer__title').textContent()).toBe(normalName)
      await page.keyboard.press('Escape')
      await page.locator('.viewer').waitFor({ state: 'detached' })
      const protectedName = await protectedCard.locator('.assistant__pic-name').textContent()
      await protectedCard.dblclick()
      await page.waitForFunction(() => (document.querySelector('.viewer__pic') as HTMLImageElement | null)?.naturalWidth)
      expect(await page.locator('.viewer__title').textContent()).toBe(protectedName)
      expect(await page.locator('.viewer__pic').getAttribute('src')).toMatch(/^ltm:\/\/file\//)
      await page.keyboard.press('Escape')
      await page.locator('.viewer').waitFor({ state: 'detached' })
      await page.click('.assistant__round[aria-label="新对话"]')
      await page.click('.assistant__round[aria-label="对话记录"]')
      await page.locator('.assistant__hist-row:not(.assistant__hist-row--pinned)').first().click()
      await thumb.waitFor()
      expect(await thumb.evaluate((img) => getComputedStyle(img).filter)).toContain('blur(')
      await page.click('.assistant__r18')

      if (mode === 'light') {
        // 第一轮未包含 R-18。唯一结果临时改变分级后应消失，恢复分级后应在同一段会话中重新出现。
        const first = page.locator('.assistant__reply').first()
        for (const hide of [true, false]) {
          await nav(page, 'pics').click()
          await page.locator(`.tile[aria-label="${normalName}"]`).click()
          await page.locator('.detail-panel__switch').click()
          await page.locator('.detail-panel__r18--on').waitFor({ state: hide ? 'visible' : 'detached' })
          await nav(page, '诺诺助手').click()
          if (hide) {
            await first.getByText('这些图片目前不在检索范围内。').waitFor()
            expect(await first.locator('.assistant__pic').count()).toBe(0)
          } else {
            await first.getByText(normalName!, { exact: true }).waitFor()
          }
        }
      }

      // 交给模型，通过模拟百炼响应检索图库。
      await askAndWait(page, '有没有适合当电脑壁纸的风景照，横的那种')
      if (mode === 'light') {
        expect(await page.locator('.assistant__cache').last().innerText()).toBe('缓存命中率 60%')
        expect(await page.locator('.assistant__time').last().innerText()).toMatch(/^\d{2}:\d{2}$/u)
      }
      await s('02-chat')
      await expect(page.locator('.assistant__banner').count()).resolves.toBe(0)

      // 单击选中，双击看大图，Esc 关掉
      const pic = page.locator('.assistant__reply').last().locator('.assistant__pic').first()
      await pic.click()
      await page.waitForSelector('.assistant__pic--on')
      await pic.dblclick()
      await page.waitForSelector('.viewer__pic')
      await page.waitForFunction(() => (document.querySelector('.viewer__pic') as HTMLImageElement | null)?.complete === true)
      await page.waitForTimeout(400)
      await s('03-viewer')
      await page.keyboard.press('Escape')
      await page.waitForSelector('.viewer', { state: 'detached' })

      // 范围下拉、对话记录、右键菜单
      await page.click('.assistant__dir')
      await page.waitForSelector('.assistant__dirs')
      // 等弹出动画放完再截图
      await page.waitForTimeout(300)
      await s('04-dir-menu')
      expect(await page.locator('.assistant__dirs').getByText('pics', { exact: true }).count()).toBe(0)
      await page.locator('.assistant__dirs').getByText('测试归档', { exact: true }).click()
      await expect(page.locator('.assistant__dir-label').textContent()).resolves.toBe('测试归档')
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
    // 指令预测使用 predict 接口；浅/深色共 6 轮云端检索，每轮含工具调用与最终回答 2 次 chat 请求。
    await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
    try {
      const { rows } = await getDatabase().pg.query<{ count: number }>("select count(*)::int as count from api_usage where api='chat'")
      expect(rows[0].count).toBe(12)
    } finally {
      await closeDatabase()
    }

    // 没有凭证：整页显示“诺诺还没连上云端”
    const second = await launchApp(dirs)
    await nav(second.page, '诺诺助手').click()
    await second.page.waitForSelector('.assistant__nokey')
    await shot(second.page, 'assistant-dark-06-nokey')
    await second.app.close()
  }, 600_000)
})
