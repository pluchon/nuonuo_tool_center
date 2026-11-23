import { mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 在操作系统的拖放边界记录参数，避免 Windows 原生模态循环阻塞自动化测试。
describe('拖到别的软件', () => {
  it('原生拖拽：返回带出的文件数；找不到原图的报错', async () => {
    const dirs = freshCase('drag')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#BBD5EE' } }).jpeg().toFile(join(source, 'a.jpg'))
    await sharp({ create: { width: 600, height: 800, channels: 3, background: '#F6CDD8' } }).jpeg().toFile(join(source, 'b.jpg'))
    const { app, page } = await launchApp(dirs)
    await app.evaluate(({ BrowserWindow }) => {
      const main = globalThis as typeof globalThis & { capturedDrag?: { files?: string[]; icon: Electron.Size } }
      BrowserWindow.getAllWindows()[0].webContents.startDrag = ({ files, icon }) => {
        main.capturedDrag = { files, icon: typeof icon === 'string' ? { width: 0, height: 0 } : icon.getSize() }
      }
    })
    await importFolder(app, page, source)
    await page.locator('.side-nav__label:text-is("pics")').click()
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2)
    const result = await page.evaluate(async () => {
      const all = await window.api.gallery.list({ view: 'untagged', sort: 'new' })
      const items = all.ok ? all.data.items : []
      const res = await window.api.files.startDrag(
        items.map((i) => i.fileId),
        items[0].hash
      )
      const bad = await window.api.files.startDrag([999999], items[0].hash)
      return { res, bad, replaced: items.find((item) => item.name === 'a.jpg') }
    })
    expect(result.res).toEqual({ ok: true, data: 2 })
    expect(result.bad).toMatchObject({ ok: false, message: '原图暂时打不开，拖不出去' })
    const drag = await app.evaluate(() => (globalThis as typeof globalThis & {
      capturedDrag?: { files?: string[]; icon: Electron.Size }
    }).capturedDrag)
    expect(drag?.files?.sort()).toEqual([join(source, 'a.jpg'), join(source, 'b.jpg')])
    expect(drag?.icon).toEqual({ width: 64, height: 64 })

    await page.evaluate(() => window.api.settings.update({ watchChanges: false }))
    const replaced = join(source, 'a.jpg')
    unlinkSync(replaced)
    mkdirSync(replaced)
    if (!result.replaced) throw new Error('未找到替换路径的测试图片')
    const badPath = await page.evaluate(({ fileId, hash }) => window.api.files.startDrag([fileId], hash), result.replaced)
    expect(badPath).toMatchObject({ ok: false, message: '原图暂时打不开，拖不出去' })
    await app.close()
  }, 300_000)
})
