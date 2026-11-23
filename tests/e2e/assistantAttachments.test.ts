import { afterEach, expect, it } from 'vitest'
import sharp from 'sharp'
import { AI_MARKDOWN_MAX_BYTES } from '../../src/shared/api'
import { closeLeftoverApps, freshCase } from './support/app'
import { launchWithMockBailian } from './support/mockBailian'

afterEach(closeLeftoverApps)

it('Markdown 可单独发送，回复失败后重试和重开记录都保留文件信息', async () => {
  const { app, page } = await launchWithMockBailian(freshCase('assistant-markdown-history'))
  const prompt = '# 测试提示词\n只回复“蓝色”。'
  await app.evaluate(() => {
    const offline = globalThis.fetch
    let failNext = true
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      if (new URL(req.url).pathname.endsWith('/chat/completions') && failNext) {
        failNext = false
        return Response.json({ error: { message: '模拟回复错误' } }, { status: 400 })
      }
      return offline(req)
    }
  })
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  await page.getByRole('button', { name: '添加附件' }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: /图片或文件/ }).click()
  await (await chooser).setFiles({ name: '配色提示.MD', mimeType: '', buffer: Buffer.from(prompt) })
  const draft = page.locator('.assistant__attach')
  expect(await draft.locator('.attachment-card__name').textContent()).toBe('配色提示.MD')
  expect(await draft.locator('.attachment-card__icon').textContent()).toBe('MD')
  expect(await draft.locator('.attachment-card__type').count()).toBe(0)
  await page.getByRole('button', { name: '发送' }).click()
  const message = page.locator('.assistant__user')
  await message.getByText('配色提示.MD', { exact: true }).waitFor()
  expect(await message.locator('.assistant__bubble').count()).toBe(0)
  await page.locator('.assistant__banner .assistant__retry').click()
  await page.locator('.assistant__reply').waitFor()
  expect(await page.locator('.assistant__user').count()).toBe(1)
  await page.getByRole('button', { name: '新对话' }).click()
  await page.getByRole('button', { name: '对话记录' }).click()
  await page.locator('.assistant__hist-row').first().click()
  await message.getByText('配色提示.MD', { exact: true }).waitFor()
  expect(await message.locator('.attachment-card__icon').textContent()).toBe('MD')
})

it('可以一次选择两种附件，分别移除和替换后仍能发送并查看记录', async () => {
  const { page } = await launchWithMockBailian(freshCase('assistant-prompt-picture'))
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  const input = page.locator('.assistant__file')
  const cards = page.locator('.assistant__attach')
  const prompt = { name: '提示.md', mimeType: 'text/markdown', buffer: Buffer.from('只回答主色。') }
  const picture = { name: '蓝色.png', mimeType: 'image/png',
    buffer: await sharp({ create: { width: 128, height: 128, channels: 3, background: '#3377dd' } }).png().toBuffer() }
  await input.setInputFiles([prompt, picture])
  await cards.filter({ hasText: prompt.name }).waitFor()
  await cards.filter({ hasText: picture.name }).getByRole('button').click()
  expect(await cards.allTextContents()).toEqual([expect.stringContaining(prompt.name)])
  await input.setInputFiles(picture)
  await cards.filter({ hasText: picture.name }).waitFor()
  await cards.filter({ hasText: prompt.name }).getByRole('button').click()
  expect(await cards.allTextContents()).toEqual([expect.stringContaining(picture.name)])
  await input.setInputFiles(prompt)
  await input.setInputFiles({ ...picture, name: '替换.png' })
  await cards.filter({ hasText: '替换.png' }).waitFor()
  expect(await cards.count()).toBe(2)
  await page.getByRole('button', { name: '发送' }).click()
  await page.locator('.assistant__reply').waitFor({ timeout: 120_000 })
  const sent = page.locator('.assistant__user .attachment-card')
  expect(await sent.count()).toBe(2)
  expect(await cards.count()).toBe(0)
  await page.getByRole('button', { name: '新对话' }).click()
  await page.getByRole('button', { name: '对话记录' }).click()
  await page.locator('.assistant__hist-row').first().click()
  await sent.filter({ hasText: prompt.name }).waitFor()
  await sent.filter({ hasText: '替换.png' }).waitFor()
}, 180_000)

it('替换、移除、无效文件和延迟读取不会误发附件或清空草稿', async () => {
  const { page } = await launchWithMockBailian(freshCase('assistant-attachment-errors'))
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  const input = page.locator('.assistant__file')
  const field = page.locator('.assistant__input')
  const draft = page.locator('.assistant__attach')
  const markdown = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('# 内容') })
  await field.fill('保留这句话')
  await input.setInputFiles(markdown('原稿.md'))
  await draft.getByText('原稿.md').waitFor()
  for (const [name, bytes, error] of [
    ['超长.md', Buffer.alloc(AI_MARKDOWN_MAX_BYTES + 1), 'Markdown 文件不能超过'],
    ['空白.md', Buffer.from(' \n\t'), 'Markdown 文件为空'],
    ['编码.md', Buffer.from([0xff, 0xfe]), 'UTF-8'],
    ['意外.zip', Buffer.from('test'), '请选择图片或 Markdown 文件']
  ] as const) {
    await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
    await page.locator('.app-toast').filter({ hasText: error }).waitFor()
    expect(await draft.locator('.attachment-card__name').textContent()).toBe('原稿.md')
    await page.locator('.app-toast__btn').click()
  }

  // 精确控制先选文件的读取完成时机，验证后选文件始终优先。
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      if (this.name === '较慢.md') {
        await new Promise<void>((resolve) => window.addEventListener('finish-test-read', () => resolve(), { once: true }))
      }
      return read.call(this)
    }
  })
  await input.setInputFiles(markdown('较慢.md'))
  expect(await page.getByRole('button', { name: '发送' }).isDisabled()).toBe(true)
  await input.setInputFiles(markdown('较快.markdown'))
  await draft.getByText('较快.markdown').waitFor()
  await page.evaluate(() => window.dispatchEvent(new Event('finish-test-read')))
  await page.getByRole('button', { name: '移除附件' }).click()
  expect(await draft.count()).toBe(0)
  expect(await field.inputValue()).toBe('保留这句话')

  // 直接提供剪贴板中的匿名位图，保留用户的系统剪贴板内容。
  await page.evaluate(() => {
    const image = document.createElement('canvas')
    image.width = image.height = 1
    Object.defineProperty(navigator.clipboard, 'read', {
      configurable: true,
      value: async () => {
        const blob = await new Promise<Blob>((resolve) => image.toBlob((png) => resolve(png!), 'image/png'))
        return [new ClipboardItem({ 'image/png': blob })]
      }
    })
  })
  await page.getByRole('button', { name: '添加附件' }).click()
  await page.getByRole('menuitem', { name: /粘贴图片/ }).click()
  await draft.getByText('PNG', { exact: true }).waitFor()
  expect(await draft.locator('.attachment-card__name').count()).toBe(0)

  // 文件后缀和 MIME 均为 PNG，但内容损坏；主进程拒绝发送时保留原附件和输入文字。
  await input.setInputFiles({ name: '损坏.png', mimeType: 'image/png', buffer: Buffer.from('test') })
  await draft.getByText('损坏.png').waitFor()
  await page.getByRole('button', { name: '发送' }).click()
  await page.locator('.app-toast--error').waitFor()
  expect(await draft.locator('.attachment-card__name').textContent()).toBe('损坏.png')
  expect(await field.inputValue()).toBe('保留这句话')
  expect(await page.locator('.assistant__user').count()).toBe(0)
})
