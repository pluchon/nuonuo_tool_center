import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { importFolder, stubFolderPick } from './support/picker'

afterEach(closeLeftoverApps)

async function openGallery(name: string) {
  const dirs = freshCase(name)
  const source = join(dirs.root, '图库样本')
  mkdirSync(source, { recursive: true })
  for (const [filename, color] of [['第一张.png', '#ff0000'], ['第二张.png', '#00ff00']]) {
    await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).png().toFile(join(source, filename))
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

it('返回页面直接恢复右栏，重启后保留选择，编辑标签时可以重新展开', async () => {
  const { app, page, dirs } = await openGallery('gallery-panel-memory')
  const nav = (name: string) => page.locator(`.side-nav__label:text-is("${name}")`)
  await page.getByRole('button', { name: '收起图片详情栏' }).click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  await nav('最近导入').click()
  await page.getByRole('button', { name: '收起图片详情栏' }).waitFor()
  await nav('标签管理').click()
  await page.getByRole('button', { name: '收起标签编辑栏' }).click()
  await page.locator('#right-panel').waitFor({ state: 'hidden' })
  const panelAnimations = await page.evaluateHandle(() => {
    const names: string[] = []
    document.addEventListener('transitionrun', (event) => {
      if ((event.target as Element).id === 'right-panel') names.push(event.propertyName)
    })
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
