import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder, stubFolderPick } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 模拟一个用户把能点的地方都点一遍：每一步都看有没有控制台报错、未捕获异常
const COLORS = ['#F6CDD8', '#D8CCEF', '#BFE3D6', '#EED3B3', '#BBD5EE', '#C9A9D9']

async function makeImage(file: string, w: number, h: number, i: number): Promise<void> {
  await sharp({ create: { width: w, height: h, channels: 3, background: COLORS[i % COLORS.length] } })
    .jpeg({ quality: 88 })
    .toFile(file)
}

// 收集渲染进程的报错
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text()}`)
    }
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  return errors
}

// “打开文件夹”类按钮会真的弹资源管理器：换成只记一下
async function stubShell(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openPath = (async (p: string) => {
      g.opened.push(p)
      return ''
    }) as typeof shell.openPath
    shell.showItemInFolder = ((p: string) => {
      g.opened.push(p)
    }) as typeof shell.showItemInFolder
  })
}

function opened(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
}

function nav(page: Page, label: string) {
  return page.locator(`.side-nav__label:text-is("${label}")`)
}

async function toastGone(page: Page): Promise<void> {
  const err = page.locator('.app-toast__btn')
  if (await err.count()) {
    await err.click()
  }
  await page.waitForSelector('.app-toast', { state: 'detached', timeout: 15_000 })
}

describe('模拟用户全流程', () => {
  it('导入、浏览、编辑、筛选、面板动画、大图、复制移动（含图库外）、目录、标签、设置都走一遍，没有报错', async () => {
    const dirs = freshCase('usersim')
    const source = join(dirs.root, 'pics')
    const outside = join(dirs.root, 'outside')
    mkdirSync(join(source, 'trip'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    mkdirSync(dirs.library, { recursive: true })
    const sizes: Array<[number, number]> = [
      [1600, 900],
      [900, 1200],
      [1200, 1200],
      [3000, 600],
      [600, 2400],
      [1280, 720]
    ]
    for (const [i, [w, h]] of sizes.entries()) {
      await makeImage(join(source, i < 4 ? '' : 'trip', `img-${i}.jpg`), w, h, i)
    }

    const { app, page } = await launchApp(dirs)
    const errors = watchErrors(page)
    await stubShell(app)

    // 第一次打开：系统对话框取消什么都不发生，选好后导入并进入这个源目录
    await stubFolderPick(app, null)
    await page.click('.gallery__pick')
    await expect(page.locator('.gallery__pick').count()).resolves.toBe(1)
    await importFolder(app, page, source)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 6)

    // 详情：改名（Esc 放弃、回车保存）、加标签、去标签、R-18、打开源目录
    await page.click('.tile:has-text("img-0.jpg")')
    await page.fill('#nameInput', '不要这个名字')
    await page.press('#nameInput', 'Escape')
    await expect(page.locator('#nameInput').inputValue()).resolves.toBe('')
    await page.fill('#nameInput', '海边日落')
    await page.press('#nameInput', 'Enter')
    await page.waitForSelector('.tile:has-text("海边日落")')
    for (const t of ['风景', '海', '临时']) {
      await page.fill('.tag-editor__input', t)
      await page.press('.tag-editor__input', 'Enter')
      await page.waitForSelector(`.tag-editor__tag:has-text("${t}")`)
    }
    await page.locator('.tag-editor__tag:has-text("临时") button').click()
    await page.waitForSelector('.tag-editor__tag:has-text("临时")', { state: 'detached' })
    await page.click('.detail-panel__switch')
    await page.waitForSelector('.detail-panel__r18--on')
    await page.click('.detail-panel__switch')
    await page.waitForSelector('.detail-panel__r18--on', { state: 'detached' })
    // 路径一行：文件夹按钮在路径左边
    const iconBox = (await page.locator('.detail-panel__path .detail-panel__open').boundingBox())!
    const textBox = (await page.locator('.detail-panel__path-text').boundingBox())!
    expect(iconBox.x).toBeLessThan(textBox.x)
    await shot(page, 'usersim-detail')
    await page.click('.detail-panel__path .detail-panel__open')
    await expect.poll(async () => (await opened(app)).length).toBe(1)

    // 第二张也打标签，好让“全部图片”里有两张
    await page.click('.tile:has-text("img-1.jpg")')
    await page.fill('.tag-editor__input', '风')
    // 输入时出建议，点建议加上
    await page.click('.tag-editor__sugg:has-text("风景")')
    await page.waitForSelector('.tag-editor__tag:has-text("风景")')

    // 键盘：← → 换选中，Ctrl + A 全选，Esc 回单选，Delete 弹确认再取消
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Control+a')
    await page.waitForSelector('.batch-panel')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.batch-panel', { state: 'detached' })
    await page.keyboard.press('Delete')
    await page.waitForSelector('.confirm-dlg')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.confirm-dlg', { state: 'detached' })

    // 全部图片：筛选、排序、搜索；筛到没有图时详情面板收起，清掉筛选后再展开
    await nav(page, '全部图片').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    await page.waitForSelector('.gallery__side')
    await expect(page.locator('.filter-chips__count').count()).resolves.toBe(0)
    await page.click('.filter-bar__btn >> nth=2')
    await page.click('.filter-bar__pill:has-text("RAW")')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.gallery__empty')
    await page.waitForSelector('.gallery__side', { state: 'detached' })
    await page.waitForSelector('.filter-chips__count')
    await page.click('.filter-chips__x')
    await page.waitForSelector('.gallery__side')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    // 手动收起后可以用同一入口再次展开。
    await page.getByRole('button', { name: '收起图片详情栏' }).click()
    await page.locator('.gallery__side').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '展开图片详情栏' }).click()
    await page.locator('.gallery__side').waitFor()
    // 排序、标签筛选、搜索
    await page.click('.filter-bar__btn >> nth=3')
    await page.click('.filter-bar__opt:has-text("名称")')
    await page.click('.filter-bar__btn >> nth=0')
    await page.click('.filter-bar__check:has-text("海")')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await page.click('.filter-chips__x >> nth=0')
    await page.fill('.filter-bar__search input', '日落')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1)
    await page.fill('.filter-bar__search input', '')

    // 大图：Ctrl + 滚轮以鼠标为中心缩放（鼠标在右上，图往左下移）
    await nav(page, 'pics').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 6)
    await page.dblclick('.tile >> nth=0')
    await page.waitForSelector('.viewer__pic')
    const stage = (await page.locator('.viewer__pan').boundingBox())!
    await page.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height * 0.25)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    const style = (await page.locator('.viewer__pic').getAttribute('style')) ?? ''
    const [, tx, ty] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(style) ?? []
    expect(Number(tx)).toBeLessThan(0)
    expect(Number(ty)).toBeGreaterThan(0)
    await page.keyboard.press('Escape')

    // 复制到图库外：图库不变，文件导出过去
    await toastGone(page)
    await page.click('.tile:has-text("img-1.jpg")')
    await stubFolderPick(app, outside)
    await page.click('.detail-panel__act:has-text("复制到")')
    await page.click('.transfer-dlg__pick')
    await page.waitForSelector('.transfer-dlg__row--other.transfer-dlg__row--on')
    await expect(page.locator('.transfer-dlg__row--other .transfer-dlg__note').textContent()).resolves.toBe('图库外')
    await shot(page, 'usersim-transfer-other')
    await page.click('.transfer-dlg__confirm')
    await page.waitForSelector('.app-toast:has-text("已复制 1 张")')
    expect(readdirSync(outside)).toEqual(['img-1.jpg'])
    await expect(page.locator('.tile').count()).resolves.toBe(6)

    // 移动到图库外：这张离开图库；撤销后回来
    await toastGone(page)
    await page.click('.tile:has-text("img-2.jpg")')
    await page.click('.detail-panel__act:has-text("移动到")')
    await page.click('.transfer-dlg__pick')
    await page.click('.transfer-dlg__confirm')
    await page.waitForSelector('.app-toast:has-text("移出图库")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 5)
    expect(existsSync(join(outside, 'img-2.jpg'))).toBe(true)
    await page.click('.app-toast button:has-text("撤销")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 6)
    expect(existsSync(join(source, 'img-2.jpg'))).toBe(true)

    // 目录：新建类目录、改名、右键菜单打开、把图拖进源目录子文件夹（复制）
    await toastGone(page)
    await page.click('.side-nav__card[aria-label="类目录"] .side-nav__add')
    await page.fill('.side-nav__edit-input', '收藏')
    await page.press('.side-nav__edit-input', 'Enter')
    await page.waitForSelector('.side-nav__label:text-is("收藏")')
    await nav(page, '收藏').click({ button: 'right' })
    await page.click('.folder-menu__item:has-text("打开所在文件夹")')
    await expect.poll(async () => (await opened(app)).length).toBe(2)
    await nav(page, 'pics').click()
    await page.locator('.side-nav__row').filter({ has: nav(page, 'pics') }).locator('.side-nav__caret').click()
    await page.waitForSelector('.side-nav__label:text-is("trip")')
    await page.dragAndDrop('.tile:has-text("img-1.jpg")', '.side-nav__row:has(.side-nav__label:text-is("trip"))')
    await page.click('.confirm-dlg__ok')
    await page.waitForSelector('.app-toast:has-text("已复制 1 张到「trip」")')

    // 大图里放大后点“适应窗口”“原始大小”“旋转”
    await page.dblclick('.tile >> nth=1')
    await page.click('.viewer__pill:has-text("原始大小")')
    await page.click('.viewer__round[aria-label="向左旋转"]')
    await page.click('.viewer__pill:has-text("适应窗口")')
    await page.click('.viewer__close')

    // 标签管理：新建、加别名、删除
    await nav(page, '标签管理').click()
    await page.click('.tags-view__new')
    await page.fill('#tagNameInput', '天空')
    await page.fill('.tag-panel__alias-input', 'sky')
    await page.press('.tag-panel__alias-input', 'Enter')
    await page.click('.tag-panel__save')
    await page.waitForSelector('.tags-view__tag:has-text("天空")')
    await page.click('.tag-panel__pill--del')
    await page.click('.confirm-dlg__ok')
    await page.waitForSelector('.tags-view__tag:has-text("天空")', { state: 'detached' })

    // 设置：每个分类点一遍，开关来回切
    await page.click('.title-bar__gear')
    for (const tab of ['外观', '常规', '图库', '数据与缓存', 'AI', '快捷键', '关于']) {
      await page.click(`.set-dlg__tab:has-text("${tab}")`)
    }
    await page.click('.set-dlg__tab:has-text("常规")')
    await page.locator('.set-dlg__row').filter({ hasText: 'R-18 缩略图模糊' }).locator('.set-dlg__switch').click()
    await page.locator('.set-dlg__row').filter({ hasText: 'R-18 缩略图模糊' }).locator('.set-dlg__switch').click()
    await page.click('.set-dlg__seg-btn:has-text("名称")')
    await page.click('.set-dlg__tab:has-text("外观")')
    await page.click('.set-dlg__swatch[aria-label="粉"]')
    await page.click('.set-dlg__bg[aria-label="Paper"]')
    await page.click('.set-dlg__seg-btn:has-text("深色")')
    await page.click('.set-dlg__bg[aria-label="默认"]')
    await page.click('.set-dlg__seg-btn:has-text("浅色")')
    await page.click('.set-dlg__tab:has-text("数据与缓存")')
    await page.click('.set-dlg__row:has-text("数据文件夹") .set-dlg__btn')
    await expect.poll(async () => (await opened(app)).length).toBe(3)
    await page.keyboard.press('Escape')

    // 深色下再走一下主要页面
    await setAppearance(page, 'dark')
    for (const label of ['全部图片', '还没打标签', '最近导入', 'pics', '收藏', '标签管理', 'R-18 图']) {
      await nav(page, label).click()
      await page.waitForTimeout(150)
    }
    // 窗口按钮：最大化再还原
    await page.click('.title-bar__win--max')
    await page.click('.title-bar__win--max')

    expect(errors).toEqual([])
    await app.close()
  })
})
