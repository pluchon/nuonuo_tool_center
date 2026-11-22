import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 系统原生拖拽本身要真人按住鼠标拖，这里只验证：找得到原文件、能做出跟手小图、调用能正常返回。
// Windows 的拖拽是一个模态循环，没有真鼠标时要等十几秒系统才放弃，所以不卡时间
describe('拖到别的软件', () => {
  it('原生拖拽：返回带出的文件数；找不到原图的报错', async () => {
    const dirs = freshCase('drag')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#BBD5EE' } }).jpeg().toFile(join(source, 'a.jpg'))
    await sharp({ create: { width: 600, height: 800, channels: 3, background: '#F6CDD8' } }).jpeg().toFile(join(source, 'b.jpg'))
    const { app, page } = await launchApp(dirs)
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
      return { res, bad }
    })
    expect(result.res).toEqual({ ok: true, data: 2 })
    expect(result.bad).toMatchObject({ ok: false, message: '原图暂时打不开，拖不出去' })
    await app.close()
  }, 300_000)
})
