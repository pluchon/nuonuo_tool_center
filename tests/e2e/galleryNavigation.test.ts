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
  await nav('图库样本').click()
  await page.getByRole('button', { name: '展开图片详情栏' }).waitFor()
  await nav('最近导入').click()
  await page.locator('#right-panel').waitFor()
  await nav('标签管理').click()
  await page.getByRole('button', { name: '展开标签编辑栏' }).waitFor()
  expect(await page.locator('#right-panel').evaluate(el => el.getAnimations().length)).toBe(0)
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

it('右栏宽度连续变化，缩略图按中间宽度重排', async () => {
  const { page } = await openGallery('gallery-fluid-panel')
  const toggle = page.locator('.title-bar__panel-toggle')
  const panel = page.locator('#right-panel')
  const dimensions = () => page.evaluate(() => [
    document.querySelector('.image-grid')!.clientWidth,
    document.querySelector('.tile')!.getBoundingClientRect().width
  ])
  const open = await dimensions()
  for (const closing of [true, false]) {
    // 固定在过渡中点，直接测量活跃的图库及卡片。
    await toggle.evaluate(async (el: HTMLElement) => {
      el.click()
      await Promise.resolve()
      const panel = document.querySelector<HTMLElement>('#right-panel')!
      panel.getBoundingClientRect()
      for (const animation of panel.getAnimations()) {
        animation.pause()
        animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
      }
    })
    await expect.poll(() => panel.evaluate(el => el.clientWidth)).toBe(150)
    await expect.poll(async () => (await dimensions())[1]).toBeGreaterThan(open[1])
    const middle = await dimensions()
    await shot(page, 'gallery-fluid-midpoint')
    await panel.evaluate(el => el.getAnimations().forEach(animation => animation.finish()))
    await expect.poll(() => panel.evaluate(el => el.clientWidth)).toBe(closing ? 0 : 300)
    if (closing) {
      await expect.poll(async () => (await dimensions())[1]).toBeGreaterThan(middle[1])
      expect((await dimensions())[0]).toBeGreaterThan(middle[0])
    } else {
      await expect.poll(dimensions).toEqual(open)
    }
    expect(await page.locator('.tile[style*="view-transition-name"]').count()).toBe(0)
  }
})

it('侧栏开合时图片随行连续上下移动，中间帧没有遮挡或重建', async () => {
  const { page } = await openGallery('gallery-wrap-motion', 18)
  await expect.poll(() => page.locator('.tile').count()).toBe(18)
  for (const closing of [true, false]) {
    const sample = await page.evaluate(async () => {
      const tiles = Array.from(document.querySelectorAll<HTMLElement>('.tile'))
      const positions = () => tiles.map(tile => tile.getBoundingClientRect().top)
      const start = positions()
      document.querySelector<HTMLButtonElement>('.title-bar__panel-toggle')!.click()
      await Promise.resolve()
      const panel = document.querySelector<HTMLElement>('#right-panel')!
      panel.getBoundingClientRect()
      const motion = panel.getAnimations()
      const frames: number[][] = []
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        for (const animation of motion) {
          animation.pause()
          animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction
        }
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
        const boxes = tiles.map(tile => tile.getBoundingClientRect())
        for (const [index, box] of boxes.entries()) {
          for (const other of boxes.slice(index + 1)) {
            const overlap = Math.min(box.right, other.right) - Math.max(box.left, other.left)
            if (overlap > 1 && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1) {
              throw new Error('缩略图在过渡中相互遮挡')
            }
          }
        }
        frames.push(positions())
      }
      motion.forEach(animation => animation.finish())
      const end = frames[3]
      const index = start.findIndex((y, i) => Math.abs(y - end[i]) > 75)
      if (index < 0) throw new Error('后续图片行没有随宽度上下移动')
      return {
        steps: frames.map(frame => (frame[index] - start[index]) / (end[index] - start[index])),
        retained: tiles.every(tile => tile.isConnected), panelWidth: panel.clientWidth
      }
    })
    expect(sample.steps[0]).toBeGreaterThan(0)
    expect(sample.steps[1]).toBeCloseTo(0.5, 1)
    expect(sample.steps[2]).toBeLessThan(1)
    expect(sample.steps).toEqual([...sample.steps].sort((a, b) => a - b))
    expect(sample.retained).toBe(true)
    expect(sample.panelWidth).toBe(closing ? 0 : 300)
  }
  await page.locator('.title-bar__panel-toggle').evaluate(async (button: HTMLElement) => {
    button.click()
    await Promise.resolve()
    const panel = document.querySelector<HTMLElement>('#right-panel')!
    panel.getBoundingClientRect()
    for (const animation of panel.getAnimations()) {
      animation.pause()
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
    }
  })
  await shot(page, 'gallery-wrap-midpoint')
})

it('虚拟图库连续切换右栏保持当前位置，减少动画时直接完成', async () => {
  const { page } = await openGallery('gallery-panel-motion', 240)
  const grid = page.locator('.image-grid')
  await expect.poll(() => grid.evaluate(el => el.scrollHeight > 2800 && el.querySelectorAll('.tile').length > 0 && [...el.querySelectorAll('.image-grid__count')].reduce((s, e) => s + parseInt(e.textContent ?? '0'), 0) === 240), { timeout: 45_000 }).toBe(true)
  await grid.evaluate(el => { el.scrollTop = 2800 })
  const visible = () => grid.evaluate(el => {
    const {top, bottom} = el.getBoundingClientRect()
    return [...el.querySelectorAll<HTMLElement>('.tile')].filter(tile => {
      const box = tile.getBoundingClientRect()
      return box.bottom > top && box.top < bottom
    }).map(tile => tile.dataset.id)
  })
  await expect.poll(async () => (await visible()).length).toBeGreaterThan(0)
  const [anchor] = await visible()
  const toggle = page.locator('.title-bar__panel-toggle')
  await toggle.click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  await expect.poll(visible).toContain(anchor)
  expect(await grid.locator('.tile').count()).toBeLessThan(100)
  await toggle.click()
  await toggle.click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await toggle.click()
  expect(await page.locator('#right-panel').evaluate(el => [el.clientWidth, el.getAnimations().length])).toEqual([300, 0])
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
