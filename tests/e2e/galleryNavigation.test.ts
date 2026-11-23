import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, shot } from './support/app'
import { importFolder, stubFolderPick } from './support/picker'

afterEach(closeLeftoverApps)

async function openGallery(name: string, count = 2) {
  const dirs = freshCase(name)
  const source = join(dirs.root, '图库样本')
  mkdirSync(source, { recursive: true })
  const samples = [
    { filename: '第一张.png', width: 64, color: '#ff0000' },
    { filename: '第二张.png', width: 36, color: '#00ff00' }
  ]
  for (const { filename, color, width } of samples) {
    await sharp({ create: { width, height: 48, channels: 3, background: color } }).png().toFile(join(source, filename))
  }
  for (let i = 2; i < count; i++) {
    await sharp({ create: { width: 52 + i % 37, height: 48, channels: 3, background: { r: 64, g: i % 256, b: 192 } } })
      .png().toFile(join(source, `样本-${i}.png`))
  }
  const result = await launchApp(dirs)
  await importFolder(result.app, result.page, source)
  await result.page.locator('.tile').nth(1).waitFor()
  return { ...result, dirs }
}

it('输入搜索词后立即切换视图，旧视图的延迟搜索不会修改新视图', async () => {
  const { page } = await openGallery('gallery-search-navigation')
  const search = page.locator('.filter-bar__input')
  await page.clock.install()
  // 同一轮事件内输入并切换，确保覆盖搜索尚未提交的情况。
  await page.locator('.side-nav__label:text-is("最近导入")').evaluate((nextView) => {
    const input = document.querySelector<HTMLInputElement>('.filter-bar__input')!
    input.value = '没有此图'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    nextView.click()
  })
  await page.clock.runFor(500)
  expect(await search.inputValue()).toBe('')
  await expect.poll(() => page.locator('.tile').count()).toBe(2)
})

it('中文输入法选词期间保留搜索结果，确认后筛选，普通 Escape 清空搜索', async () => {
  const { page } = await openGallery('gallery-search-ime')
  const input = page.locator('.filter-bar__input')
  await input.focus()
  await input.dispatchEvent('compositionstart')
  await input.evaluate((el: HTMLInputElement) => {
    el.value = 'di yi'
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
  })
  await page.waitForTimeout(350)
  expect(await input.inputValue()).toBe('di yi')
  expect(await page.locator('.tile').count()).toBe(2)
  await input.evaluate((el: HTMLInputElement) => {
    el.value = '第一'
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '第一' }))
  })
  await expect.poll(() => page.locator('.tile__name').allTextContents()).toEqual(['第一张.png'])
  await input.press('Escape')
  await expect.poll(() => page.locator('.tile').count()).toBe(2)
  expect(await input.inputValue()).toBe('')
  await page.locator('.tile').first().click()
  const tag = page.getByRole('textbox', { name: '添加标签' })
  await tag.fill('bei jing')
  await tag.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
  expect(await tag.inputValue()).toBe('bei jing')
  await tag.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
  expect(await tag.inputValue()).toBe('bei jing')
  await tag.fill('背景')
  await tag.press('Enter')
  await page.locator('.tag-editor__tag').filter({ hasText: '背景' }).waitFor()
  expect(await page.locator('.tag-editor__tag').filter({ hasText: 'bei jing' }).count()).toBe(0)
})

it('返回页面直接恢复右栏，重启后保留选择，编辑标签时可以重新展开', async () => {
  const { app, page, dirs } = await openGallery('gallery-panel-memory')
  const nav = (name: string) => page.locator(`.side-nav__label:text-is("${name}")`)
  const collapse = page.getByRole('button', { name: '收起图片详情栏' })
  await collapse.hover()
  expect(await page.locator('[title]').count()).toBe(0)
  await collapse.click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  await nav('最近导入').click()
  await page.getByRole('button', { name: '收起图片详情栏' }).waitFor()
  await nav('标签管理').click()
  await page.getByRole('button', { name: '收起标签编辑栏' }).click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  await page.waitForFunction(() => !document.documentElement.classList.contains('panel-motion'))
  const panelAnimations = await page.evaluateHandle(() => {
    const names: string[] = []
    new MutationObserver(records => {
      for (const record of records) {
        if ((record.target as Element).classList.contains('panel-motion')) names.push('panel-motion')
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], attributeOldValue: true })
    return names
  })
  await nav('图库样本').click()
  await page.getByRole('button', { name: '展开图片详情栏' }).waitFor()
  await nav('最近导入').click()
  await page.locator('#right-panel').waitFor()
  await nav('标签管理').click()
  await page.getByRole('button', { name: '展开标签编辑栏' }).waitFor()
  expect(await panelAnimations.jsonValue()).toEqual([])
  await page.getByRole('button', { name: '新建标签' }).click()
  await page.locator('#tagNameInput').fill('临时草稿')
  await page.getByRole('button', { name: '收起标签编辑栏' }).click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '展开标签编辑栏' }).click()
  expect(await page.locator('#tagNameInput').inputValue()).toBe('临时草稿')
  await app.close()
  const reopened = await launchApp(dirs)
  await reopened.page.locator('.side-nav__label:text-is("图库样本")').click()
  await reopened.page.getByRole('button', { name: '展开图片详情栏' }).waitFor()
  expect(await reopened.page.locator('#right-panel').isVisible()).toBe(false)
})

it('右栏退出动画先于图库结束时，旧面板不会闪回', async () => {
  const { app, page } = await openGallery('gallery-panel-exit')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  // 用色块识别面板快照，暂停图库动画以检查两者结束之间的画面。
  await page.addStyleTag({ content: `
    #right-panel { position: relative }
    #right-panel::after { content: ''; position: absolute; top: 48px; left: 2px; width: 24px; height: 24px; background: #ff00ff; }
    :root.panel-motion::view-transition-group(panel-controls) { animation-play-state: paused; }
  ` })
  const markerPixels = async (name: string) => {
    const pixels = await sharp(await shot(page, name)).removeAlpha().raw().toBuffer()
    let count = 0
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] > 245 && pixels[i + 1] < 10 && pixels[i + 2] > 245) count++
    }
    return count
  }
  expect(await markerPixels('panel-exit-open')).toBeGreaterThan(100)
  await page.getByRole('button', { name: '收起图片详情栏' }).click()
  await page.waitForFunction(() => {
    const animations = document.getAnimations()
    return animations.some(a => a.playState === 'paused') &&
      !animations.some(a => a instanceof CSSAnimation && a.animationName === 'panel-slide' && a.playState === 'running')
  })
  try {
    expect(await markerPixels('panel-exit-last-frame')).toBe(0)
  } finally {
    await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'paused').forEach(a => a.finish()))
  }
  await page.waitForFunction(() => !document.documentElement.classList.contains('panel-motion'))
  expect(await page.locator('#right-panel').isVisible()).toBe(false)
})

it('只有两张图时，收起和展开右栏的中间画面都能看到缩略图逐渐缩放', async () => {
  const { app, page } = await openGallery('gallery-fluid-thumbnails')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('.tile__pic')]
    return images.length === 2 && images.every(img => img.complete && img.naturalWidth)
  })
  const bounds = await page.locator('.image-grid').boundingBox()
  // 给展开状态加一个标记，检查收起中途是否重复绘制旧卡片。
  await page.addStyleTag({ content: `
    .gallery--main:has(#right-panel:not([style*="display: none"])) .tile::after {
      content: ''; position: absolute; inset: 12px auto auto 12px; width: 16px; height: 16px; background: #ff00ff;
    }` })
  const greenArea = async (name: string) => {
    const file = await shot(page, name)
    const pixels = await sharp(file).extract({
      left: Math.ceil(bounds!.x), top: Math.ceil(bounds!.y),
      width: Math.floor(bounds!.width) - 1, height: Math.floor(bounds!.height) - 1
    }).removeAlpha().raw().toBuffer()
    let area = 0
    let oldPixels = 0
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] < 30 && pixels[i + 1] > 225 && pixels[i + 2] < 30) area++
      if (pixels[i] > 220 && pixels[i + 1] < 35 && pixels[i + 2] > 220) oldPixels++
    }
    if (name === 'fluid-panel-open') expect(oldPixels).toBeGreaterThan(200)
    if (name === 'fluid-panel-closing') expect(oldPixels).toBe(0)
    return area
  }
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document)
    document.startViewTransition = cb => {
      const t = start(cb)
      void t.ready.then(() => {
        for (const a of document.getAnimations()) {
          if (!(a instanceof CSSAnimation) || !/view-transition|panel-slide/.test(a.animationName)) continue
          a.pause()
          a.currentTime = Number(a.effect!.getTiming().duration) / 2
        }
      })
      return t
    }
  })
  const areaWithPanel = await greenArea('fluid-panel-open')
  expect(areaWithPanel).toBeGreaterThan(1000)
  const toggle = page.locator('.title-bar__panel-toggle')
  const toggleAndSample = async (name: string) => {
    await toggle.click()
    await page.waitForFunction(() => document.getAnimations().some(a => a.playState === 'paused'))
    const area = await greenArea(name)
    await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'paused').forEach(a => a.finish()))
    await page.waitForFunction(() => !document.documentElement.classList.contains('panel-motion'))
    return area
  }
  const closing = await toggleAndSample('fluid-panel-closing')
  const areaWithoutPanel = await greenArea('fluid-panel-closed')
  const opening = await toggleAndSample('fluid-panel-opening')
  expect(areaWithoutPanel).toBeGreaterThan(areaWithPanel)
  for (const mid of [closing, opening]) {
    const progress = (mid - areaWithPanel) / (areaWithoutPanel - areaWithPanel)
    expect(progress).toBeGreaterThan(0.2)
    expect(progress).toBeLessThan(0.8)
  }
  expect(await greenArea('fluid-panel-restored')).toBe(areaWithPanel)
})

it('虚拟图库中手动切换右栏时只移动当前视口的缩略图，连续切换和减少动画设置均能恢复', async () => {
  const { app, page } = await openGallery('gallery-panel-motion', 240)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  await expect.poll(() => page.locator('.image-grid__row').count(), { timeout: 45_000 }).toBeGreaterThan(45)
  const grid = page.locator('.image-grid')
  await grid.evaluate(el => { el.scrollTop = 2800 })
  const topImage = () => grid.evaluate(el => {
    const top = el.getBoundingClientRect().top
    return [...el.querySelectorAll<HTMLElement>('.tile')].find(t => {
      const r = t.getBoundingClientRect()
      return r.bottom > top && r.top < top + el.clientHeight
    })?.dataset.id
  })
  await expect.poll(topImage).toBeTruthy()
  const anchor = await topImage()
  const readMotion = await page.evaluateHandle(() => {
    const start = document.startViewTransition.bind(document)
    const samples: string[][] = []
    document.startViewTransition = cb => {
      const t = start(cb)
      t.ready.then(() => {
        const animations = document.getAnimations().filter(a => a instanceof CSSAnimation && /view-transition|panel-slide/.test(a.animationName))
        samples.push(animations.map(a => (a as CSSAnimation).animationName))
        if (samples.length === 1) {
          for (const a of animations) { a.pause(); a.currentTime = Number(a.effect!.getTiming().duration) / 2 }
        }
      }).catch(err => samples.push([String(err)]))
      return t
    }
    return samples
  })
  const toggle = page.locator('.title-bar__panel-toggle')
  await toggle.click()
  await expect.poll(async () => (await readMotion.jsonValue()).length, { timeout: 5000 }).toBe(1)
  const samples = await readMotion.jsonValue()
  const movingTiles = samples.flat().filter(name => name.includes('group') && name.includes('panel-tile-'))
  expect(movingTiles.length).toBeGreaterThan(0)
  expect(movingTiles.length).toBeLessThan(80)
  await shot(page, 'gallery-panel-midpoint')
  await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'paused').forEach(a => a.play()))
  await page.waitForFunction(() => !document.querySelector('.panel-motion') && !document.querySelector<HTMLElement>('#right-panel')?.offsetWidth)
  expect(await grid.locator(`[data-id="${anchor}"]`).evaluate(el => {
    const r = el.getBoundingClientRect()
    const viewport = el.closest('.image-grid')!.getBoundingClientRect()
    return r.bottom > viewport.top && r.top < viewport.bottom
  })).toBe(true)
  await toggle.click()
  await page.waitForFunction(() => !document.querySelector('.panel-motion') && !!document.querySelector<HTMLElement>('#right-panel')?.offsetWidth)
  await toggle.evaluate(async (button: HTMLElement) => {
    button.click()
    await new Promise(resolve => setTimeout(resolve, 10))
    button.click()
  })
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
  await page.waitForFunction(() => !document.querySelector('.panel-motion') && !!document.querySelector<HTMLElement>('#right-panel')?.offsetWidth)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const before = (await readMotion.jsonValue()).length
  await toggle.click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  expect((await readMotion.jsonValue()).length).toBe(before)
  expect(await grid.locator('[style*="view-transition-name"]').count()).toBe(0)
}, 120_000)

it('切换目录后查询失败，旧列表和旧图片操作不会出现在新视图', async () => {
  const { app, page } = await openGallery('gallery-failed-navigation')
  const recent = await page.evaluate(() => window.api.gallery.list({ view: 'recent', sort: 'new' }))
  expect(recent.ok).toBe(true)
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('gallery:list')
    ipcMain.handle('gallery:list', async () => {
      await new Promise((done) => setTimeout(done, 500))
      return { ok: false, code: 'DEPENDENCY_FAILED', message: '模拟目录暂时不可读' }
    })
  })
  await page.locator('.side-nav__label:text-is("最近导入")').click()
  await expect.poll(() => page.locator('.gallery__retry').count()).toBe(1)
  expect(await page.locator('.tile').count()).toBe(0)
  await page.keyboard.press('Delete')
  expect(await page.locator('.confirm-dlg').count()).toBe(0)
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('gallery:list')
    ipcMain.handle('gallery:list', () => result)
  }, recent)
  await page.locator('.gallery__retry').click()
  await expect.poll(() => page.locator('.tile').count()).toBe(2)
})

it('目录确认框打开时屏蔽网格快捷键，退出动画期间恢复复制、全选和搜索', async () => {
  const { app, page } = await openGallery('gallery-modal-shortcuts')
  // 仅验证图库分发复制操作，保留系统剪贴板原有内容。
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('file:copyImage')
    ipcMain.handle('file:copyImage', () => ({ ok: true, data: null }))
  })
  await page.locator('.side-nav__row:has(.side-nav__label:text-is("图库样本"))').click({ button: 'right' })
  await page.locator('.folder-menu__item:has-text("从图库移除")').click()
  const title = page.locator('.confirm-dlg__title')
  await title.waitFor()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  expect(await title.allTextContents()).toEqual(['从图库移除「图库样本」？'])
  expect(await page.locator('.tile--on').count()).toBe(1)
  // 延长退出动画，以便在弹窗仍显示、已经允许点击网格的阶段验证快捷键。
  await page.addStyleTag({ content: '.nn-dlg-leave-active { transition-duration: 2s !important }' })
  await page.keyboard.press('Escape')
  await page.locator('.confirm-dlg.nn-dlg-leave-active').waitFor({ state: 'attached' })
  await page.locator('.tile').first().click()
  expect(await title.count()).toBe(1)
  await page.keyboard.press('Control+c')
  await page.locator('.app-toast:has-text("已复制图片")').waitFor()
  await page.keyboard.press('Control+a')
  await expect.poll(() => page.locator('.tile--on').count()).toBe(2)
  await page.keyboard.press('Control+f')
  expect(await page.locator('.filter-bar__input').evaluate((input) => document.activeElement === input)).toBe(true)
})

it.each(['复制', '移动'])('目录列表响应缓慢时，%s操作仍使用发起操作时的图片', async (action) => {
  const { app, page, dirs } = await openGallery(`gallery-transfer-selection-${action}`)
  const target = join(dirs.root, '目标目录')
  mkdirSync(target)
  await stubFolderPick(app, target)
  const roots = await page.evaluate(() => window.api.files.transferRoots())
  expect(roots.ok).toBe(true)
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('file:transferRoots')
    ipcMain.handle('file:transferRoots', async () => {
      await new Promise((done) => setTimeout(done, 500))
      return result
    })
  }, roots)
  await page.locator('.tile:has-text("第一张.png")').click()
  await page.locator('#nameInput[placeholder="第一张.png"]').waitFor()
  const start = page.getByRole('button', { name: `${action}到…`, exact: true })
  await start.evaluate((button) => {
    button.click()
    document.querySelector<HTMLElement>('.tile[aria-label="第二张.png"]')!.click()
  })
  await page.locator('.transfer-dlg__pick').click()
  await page.locator('.transfer-dlg__confirm').click()
  await expect.poll(() => readdirSync(target)).toHaveLength(1)
  expect(readdirSync(target)).toEqual(['第一张.png'])
})
