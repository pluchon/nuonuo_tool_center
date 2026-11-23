import { afterEach, expect, it } from 'vitest'
import sharp from 'sharp'
import { closeLeftoverApps, freshCase, shot } from './support/app'
import { launchWithMockBailian } from './support/mockBailian'

afterEach(closeLeftoverApps)

it('末轮可编辑重发，撤回长回复后消息对齐，重启仍能恢复两种附件并再次发送', async () => {
  const dirs = freshCase('assistant-revision-history')
  const { app, page } = await launchWithMockBailian(dirs)
  await app.evaluate(() => {
    const fixture = globalThis.fetch
    let turn = 0
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (!new URL(request.url).pathname.endsWith('/chat/completions')) return fixture(request)
      const content = ['首轮回答', '旧版回答', Array.from({ length: 80 }, (_, i) => '修订后的回答第 ' + i + ' 段。').join('\n\n')][turn++]
      return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} })
    }
  })
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  const composer = page.locator('.assistant__input')
  const send = page.getByRole('button', { name: '发送', exact: true })
  const scope = page.locator('button.assistant__dir')
  await page.mouse.move(0, 0)
  const idle = await scope.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(idle).toBe('rgba(0, 0, 0, 0)')
  // 隐藏窗口没有系统指针，用 Chromium 的悬浮状态验证同一套样式。
  const devtools = await page.context().newCDPSession(page)
  await devtools.send('DOM.enable')
  await devtools.send('CSS.enable')
  const { root } = await devtools.send('DOM.getDocument')
  const { nodeId } = await devtools.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'button.assistant__dir' })
  await devtools.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
  const hover = await scope.evaluate((el) => {
    const style = getComputedStyle(el)
    void style.backgroundColor
    for (const anim of el.getAnimations()) anim.finish()
    return { color: style.backgroundColor, accent: style.getPropertyValue('--a-soft'), hovered: el.matches(':hover') }
  })
  expect(hover.color, JSON.stringify(hover)).not.toBe(idle)
  await devtools.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
  await devtools.detach()
  await composer.fill('说一句问候')
  await send.click()
  await page.getByText('首轮回答', { exact: true }).waitFor()
  for (const selector of ['.assistant__bubble', '.assistant__text']) {
    const extra = await page.locator(selector).first().evaluate((el) => {
      const s = getComputedStyle(el)
      return el.getBoundingClientRect().height - parseFloat(s.lineHeight) - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
    })
    expect(Math.abs(extra)).toBeLessThan(2)
  }
  await shot(page, 'assistant-compact-bubbles')
  const file = { name: '检查.md', mimeType: 'text/markdown', buffer: Buffer.from('# 检查颜色') }
  const picture = { name: '背景.png', mimeType: 'image/png',
    buffer: await sharp({ create: { width: 64, height: 64, channels: 3, background: '#225588' } }).png().toBuffer() }
  await page.locator('.assistant__file').setInputFiles([file, picture])
  await page.locator('.assistant__attach').filter({ hasText: picture.name }).waitFor()
  await composer.fill('请描述颜色')
  await send.click()
  await page.getByText('旧版回答', { exact: true }).waitFor()
  const last = page.locator('.assistant__user').last()
  const edit = page.getByRole('button', { name: '编辑消息', exact: true })
  expect(await edit.count()).toBe(1)
  await last.hover()
  await edit.click()
  const field = page.getByRole('textbox', { name: '编辑消息内容' })
  expect(await field.evaluate((el) => (el as HTMLElement).isContentEditable && el.tagName !== 'TEXTAREA')).toBe(true)
  await field.fill('问好')
  const short = (await field.boundingBox())!
  await field.fill('换一句更长的问候')
  expect((await field.boundingBox())!.width).toBeGreaterThan(short.width)
  await field.fill('第一行\n第二行')
  expect((await field.boundingBox())!.height).toBeGreaterThan(short.height)
  await shot(page, 'assistant-inline-bubble-edit')
  await field.fill('取消这次编辑')
  await field.press('Escape')
  await last.getByText('请描述颜色', { exact: true }).waitFor()
  await last.hover()
  await edit.click()
  await field.fill('请解释背景色')
  await page.getByRole('button', { name: '重新发送' }).click()
  await page.getByText('修订后的回答第 79 段。', { exact: true }).waitFor()
  expect(await page.getByText('旧版回答', { exact: true }).count()).toBe(0)
  expect(await last.locator('.attachment-card').count()).toBe(2)
  expect(await page.locator('.assistant__scroll').evaluate((el) => el.scrollHeight > el.clientHeight * 2)).toBe(true)

  await composer.fill('已有输入内容')
  await last.hover()
  const recall = page.getByRole('button', { name: '回撤到输入框' })
  await recall.click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(await composer.inputValue()).toBe('已有输入内容')
  await last.hover()
  await recall.click()
  await page.getByRole('button', { name: '替换', exact: true }).click()
  await page.locator('.assistant__attach').filter({ hasText: file.name }).waitFor()
  expect(await composer.inputValue()).toBe('请解释背景色')
  expect(await page.locator('.assistant__reply').count()).toBe(1)
  const distance = await page.locator('.assistant__scroll').evaluate((el) =>
    el.querySelector('.assistant__user')!.getBoundingClientRect().top - el.getBoundingClientRect().top)
  expect(distance).toBeGreaterThanOrEqual(0)
  expect(distance).toBeLessThan(34)
  await composer.fill('切换对话时保留的修改')
  await page.getByRole('button', { name: '新对话' }).click()
  await composer.fill('新对话中的独立草稿')
  await page.getByRole('button', { name: '对话记录' }).click()
  await page.locator('.assistant__hist-row').first().click()
  await page.locator('.assistant__attach').filter({ hasText: file.name }).waitFor()
  expect(await composer.inputValue()).toBe('切换对话时保留的修改')
  await page.getByRole('button', { name: '新对话' }).click()
  expect(await composer.inputValue()).toBe('新对话中的独立草稿')
  await app.close()

  const restored = await launchWithMockBailian(dirs)
  await restored.page.locator('.side-nav__label:text-is("诺诺助手")').click()
  await restored.page.getByRole('button', { name: '对话记录' }).click()
  await restored.page.locator('.assistant__hist-row').first().click()
  await restored.page.locator('.assistant__attach').filter({ hasText: picture.name }).waitFor()
  expect(await restored.page.locator('.assistant__input').inputValue()).toBe('请解释背景色')
  expect(await restored.page.locator('.assistant__attach').count()).toBe(2)
  expect(await restored.page.locator('.assistant__reply').count()).toBe(1)
  await restored.page.getByRole('button', { name: '发送', exact: true }).click()
  await restored.page.locator('.assistant__reply').nth(1).waitFor()
  expect(await restored.page.locator('.assistant__user').last().locator('.attachment-card').count()).toBe(2)
  expect(await restored.page.locator('.assistant__attach').count()).toBe(0)
}, 120_000)
