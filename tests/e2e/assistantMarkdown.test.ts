import { afterEach, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWindow, closeLeftoverApps, freshCase } from './support/app'
import { launchWithMockBailian } from './support/mockBailian'

afterEach(closeLeftoverApps)

it('预览附件和 Markdown 草稿，代码块内回车换行，闭合后回车发送', async () => {
  const { app, page } = await launchWithMockBailian(freshCase('assistant-markdown-preview'))
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  const field = page.getByRole('textbox', { name: '问诺诺' })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await field.fill('```js')
  await field.press('Enter')
  await field.pressSequentially('const x = 1')
  await field.press('Enter')
  await field.pressSequentially('```')
  expect(await field.inputValue()).toBe('```js\nconst x = 1\n```')
  await page.getByRole('button', { name: '预览 Markdown' }).click()
  expect(await page.locator('.assistant__draft-preview pre code').innerText()).toContain('const x = 1')
  await page.getByRole('button', { name: '继续编辑' }).click()
  expect(await field.evaluate((el) => el === document.activeElement)).toBe(true)
  await send.hover()
  await expect.poll(() => send.locator('svg').evaluate((el) => getComputedStyle(el).transform)).not.toBe('none')

  const file = page.locator('.assistant__file')
  const name = '插画参考'.repeat(17) + '.md'
  const upload = (text: string) => file.setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })
  const preview = page.getByRole('dialog', { name, exact: true })
  const open = () => page.getByRole('button', { name: '查看附件 ' + name }).click()
  await upload('# 提示词\n\n**保留标签**')
  await open()
  const bounds = await preview.boundingBox()
  expect(await preview.locator('strong').innerText()).toBe('保留标签')
  await page.keyboard.press('Escape')
  await upload('# 插画参考\n\n' + '- 只核对已经确认的标签\n'.repeat(90) + '\n<img src="https://example.invalid/test">')
  await open()
  expect(await preview.boundingBox()).toEqual(bounds)
  expect(await preview.locator('h2').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await preview.locator('.file-preview__body').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await preview.locator('img').count()).toBe(0)
  await captureWindow(page, join(tmpdir(), 'nuonuo-attachment-preview.png'), app)
  await page.getByRole('button', { name: '关闭预览' }).click()
  await field.press('Enter')
  await page.locator('.assistant__reply').waitFor()
  expect(await page.locator('.assistant__user pre code').innerText()).toContain('const x = 1')
  await open()
  expect(await preview.locator('li').count()).toBe(90)
  expect(errors).toEqual([])
})
