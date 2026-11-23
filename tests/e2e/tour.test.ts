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

// 全流程走一遍：每个页面、弹窗、下拉、菜单在浅色和深色下各截一张，人工对照检查（只断言能走通，不比像素）
const PALETTE = [
  ['#F6CDD8', '#BBD5EE'],
  ['#D8CCEF', '#BFE3D6'],
  ['#EED3B3', '#F6CDD8'],
  ['#BFE3D6', '#4A86C2'],
  ['#BBD5EE', '#7A63C9']
]

// 生成一张渐变测试图（带一个圆，看得出方向）
async function makeImage(file: string, w: number, h: number, i: number): Promise<void> {
  const [a, b] = PALETTE[i % PALETTE.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.3}" cy="${h * 0.4}" r="${Math.min(w, h) / 5}" fill="#ffffff" fill-opacity="0.55"/></svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toFile(file)
}

// 侧栏某一项
function nav(page: Page, label: string) {
  return page.locator(`.side-nav__label:text-is("${label}")`)
}

// 给当前选中的图加标签
async function addTag(page: Page, name: string): Promise<void> {
  await page.fill('.tag-editor__input', name)
  await page.press('.tag-editor__input', 'Enter')
  await page.waitForSelector(`.tag-editor__tag:has-text("${name}")`)
}

// 点一下空白处，收起下拉
async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.mouse.click(640, 790)
}

async function lightAndDarkPass(page: Page, mode: 'light' | 'dark'): Promise<void> {
  const s = (name: string): Promise<string> => shot(page, `tour-${mode}-${name}`)
  await nav(page, 'pics').click()
  await page.waitForFunction(() => document.querySelectorAll('.tile').length > 5)
  await page.click('.tile >> nth=1')
  await page.waitForSelector('.detail-panel__preview')
  await s('01-source-detail')

  await nav(page, '全部图片').click()
  await page.waitForSelector('.tile')
  await page.click('.filter-bar__btn >> nth=0')
  await s('02-tag-dropdown')
  await dismiss(page)
  await page.click('.filter-bar__btn >> nth=1')
  await s('03-dir-dropdown')
  await dismiss(page)
  await page.click('.filter-bar__btn >> nth=2')
  await s('04-more-dropdown')
  await dismiss(page)
  await page.click('.filter-bar__btn >> nth=3')
  await s('05-sort-dropdown')
  await dismiss(page)

  // 筛一个标签：出现条件和张数
  await page.click('.filter-bar__btn >> nth=0')
  await page.click('.filter-bar__check >> nth=0')
  await dismiss(page)
  await page.waitForSelector('.filter-chips__count')
  await s('06-filtered')
  await page.click('.filter-chips__x')
  await expect(page.locator('.filter-chips__count').count()).resolves.toBe(0)

  // 多选：批量面板
  await page.click('.tile >> nth=0')
  await page.click('.tile >> nth=1', { modifiers: ['Control'] })
  await page.click('.tile >> nth=2', { modifiers: ['Control'] })
  await page.waitForSelector('.batch-panel')
  await s('07-batch')
  await page.click('.batch-panel__act:has-text("复制到")')
  await page.waitForSelector('.transfer-dlg')
  await s('08-transfer')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Delete')
  await page.waitForSelector('.confirm-dlg')
  await s('09-delete-confirm')
  await page.keyboard.press('Escape')
  await page.click('.tile >> nth=0')

  // 侧栏右键菜单、源目录树
  await nav(page, 'pics').click({ button: 'right' })
  await page.waitForSelector('.folder-menu')
  await s('10-folder-menu')
  await page.keyboard.press('Escape')

  // 大图
  await page.dblclick('.tile >> nth=0')
  await page.waitForSelector('.viewer__pic')
  await page.waitForTimeout(300)
  await s('11-viewer')
  await page.keyboard.press('Escape')

  // R-18 图
  await nav(page, 'R-18 图').click()
  await page.waitForSelector('.tile')
  await page.click('.tile >> nth=0')
  await s('12-r18-view')

  // 还没打标签、最近导入
  await nav(page, '还没打标签').click()
  await page.waitForSelector('.tile')
  await s('13-untagged')

  // 类目录
  await nav(page, '壁纸').click()
  await page.waitForSelector('.tile')
  await s('14-category')

  // 标签管理和分类对话框
  await nav(page, '标签管理').click()
  await page.waitForSelector('.tags-view')
  await s('15-tags')
  await page.click('.tags-view__kinds')
  await page.waitForSelector('.kind-dlg')
  await s('16-kinds')
  await page.keyboard.press('Escape')

  // 设置各页
  await page.click('.title-bar__gear')
  for (const tab of ['外观', '常规', '图库', 'AI', '数据与缓存', '快捷键', '关于']) {
    await page.click(`.set-dlg__tab:has-text("${tab}")`)
    await page.waitForTimeout(150)
    await s(`17-settings-${tab}`)
  }
  await page.keyboard.press('Escape')

  // 搜索没有结果
  await nav(page, '全部图片').click()
  await page.fill('.filter-bar__search input', '没有这张图')
  await page.waitForTimeout(500)
  await s('18-no-result')
  await page.fill('.filter-bar__search input', '')
}

describe('全流程巡检', () => {
  it('浅色、深色下走遍主要页面和弹窗并截图', async () => {
    const dirs = freshCase('tour')
    const source = join(dirs.root, 'pics')
    mkdirSync(join(source, 'a'), { recursive: true })
    mkdirSync(join(source, 'b'), { recursive: true })
    mkdirSync(join(dirs.library, '壁纸'), { recursive: true })
    const sizes: Array<[number, number]> = [
      [1600, 900],
      [900, 1200],
      [1200, 1200],
      [3000, 600],
      [600, 2400],
      [1280, 720],
      [800, 1000],
      [1920, 1080]
    ]
    for (const [i, [w, h]] of sizes.entries()) {
      await makeImage(join(source, i < 4 ? '' : i < 6 ? 'a' : 'b', `pic-${i}.jpg`), w, h, i)
    }
    await makeImage(join(dirs.library, '壁纸', 'wall-1.jpg'), 1920, 1080, 3)
    await makeImage(join(dirs.library, '壁纸', 'wall-2.jpg'), 1080, 1920, 4)

    const { app, page } = await launchApp(dirs)
    await shot(page, 'tour-light-00-first-run')
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.click('.title-bar__gear')
    await page.click('.set-dlg__tab:has-text("图库")')
    await page.keyboard.press('Escape')

    // 打标签、标 R-18，让各个视图都有内容
    await nav(page, 'pics').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8)
    for (const [n, tags] of [
      [0, ['风景', '天空']],
      [1, ['人物']],
      [2, ['风景']],
      [3, ['全景']]
    ] as const) {
      await page.click(`.tile >> nth=${n}`)
      for (const t of tags) {
        await addTag(page, t)
      }
    }
    await page.click('.tile >> nth=1')
    await page.click('.detail-panel__switch')
    await page.waitForSelector('.detail-panel__r18--on')
    await page.click('.side-nav__card[aria-label="类目录"] .side-nav__add')
    await page.keyboard.press('Escape')

    await lightAndDarkPass(page, 'light')
    await setAppearance(page, 'dark')
    await lightAndDarkPass(page, 'dark')
    await app.close()
  }, 360_000)
})
