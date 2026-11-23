import { afterEach, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, shot } from './support/app'
import { launchWithMockBailian } from './support/mockBailian'
import sharp from 'sharp'

afterEach(closeLeftoverApps)

it('外部拖图、附件大图查看、手动精简与继续聊天', async () => {
  const { app, page } = await launchWithMockBailian(freshCase('assistant-compact-drag'))
  await app.evaluate(() => {
    globalThis.fetch = async (url, init) => {
      const request = new Request(url, init)
      const body = await request.json()
      const compact = body.max_tokens === 1600
      if (compact) await new Promise(r => setTimeout(r, 350))
      const question = JSON.stringify(body.messages.at(-1))
      const content = compact ? '用户想将小猫取名为小雨。' : question.includes('叫什么') ?
        (JSON.stringify(body.messages).includes('以下是前文摘要') ? '小雨。' : '缺少摘要') : '小雨是个可爱的名字。'
      return Response.json({choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:94000,completion_tokens:10}})
    }
  })
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  const input = page.locator('.assistant__input')
  const bytes = [...await sharp({create:{width:32,height:24,channels:3,background:'#694890'}}).png().toBuffer()]
  await input.evaluate((el, bytes) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(bytes)],'小雨.png',{type:'image/png'}))
    el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))
  },bytes)
  await page.getByRole('button',{name:'查看附件 小雨.png'}).click()
  const viewer = page.getByRole('dialog',{name:'查看大图'})
  await expect.poll(() => viewer.locator('.viewer__pic').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(32)
  await viewer.getByRole('button',{name:'放大',exact:true}).click()
  expect(await viewer.locator('.viewer__zoom').innerText()).not.toBe('100%')
  await page.keyboard.press('Escape')
  await page.getByRole('button',{name:'移除附件 小雨.png'}).click()
  expect(await page.locator('.assistant__controls .assistant__vr').count()).toBe(3)
  await input.fill('我给小猫取名小雨，你觉得怎么样？')
  await input.press('Enter')
  await page.getByText('小雨是个可爱的名字。',{exact:true}).waitFor()
  const meter = page.getByRole('meter', { name: '对话上下文窗口' })
  expect(await meter.getAttribute('aria-valuenow')).toBe('94010')
  const ordinaryColor = await input.evaluate(el => getComputedStyle(el).color)
  await input.fill('/com')
  await page.getByRole('button',{name:'精简对话上下文'}).waitFor()
  await input.press('Enter')
  expect(await input.inputValue()).toBe('/compact')
  await expect.poll(() => input.evaluate(el => getComputedStyle(el).color)).not.toBe(ordinaryColor)
  expect(await page.locator('.assistant__user').count()).toBe(1)
  expect(await page.getByRole('button',{name:'精简对话上下文'}).count()).toBe(0)
  await input.fill('/co')
  await expect.poll(() => input.evaluate(el => getComputedStyle(el).color)).toBe(ordinaryColor)
  await page.getByRole('button',{name:'精简对话上下文'}).click()
  expect(await input.inputValue()).toBe('/compact')
  await shot(page,'assistant-compact-command')
  await input.press('Enter')
  await page.getByText('正在精简…',{exact:true}).waitFor()
  await page.getByText('已精简对话上下文',{exact:true}).waitFor()
  const after = Number(await meter.getAttribute('aria-valuenow'))
  expect(after).toBeGreaterThan(0)
  expect(after).toBeLessThan(94010)
  expect(await meter.getAttribute('aria-valuetext')).toContain('精简后估算')
  await page.getByRole('button', { name: '新对话' }).click()
  await page.getByRole('button', { name: '对话记录' }).click()
  await page.locator('.assistant__hist-row').first().click()
  await expect.poll(() => meter.getAttribute('aria-valuenow')).toBe(String(after))
  await input.fill('它叫什么？')
  await input.press('Enter')
  await page.getByText('小雨。',{exact:true}).waitFor()
  expect(await meter.getAttribute('aria-valuenow')).toBe('94010')
  await shot(page,'assistant-chat-tools-aligned')
  expect(await page.locator('.assistant__reply').count()).toBe(2)
  expect(await page.locator('.assistant__how').count()).toBe(0)
  await input.evaluate(el => {
    const dt = new DataTransfer()
    dt.items.add(new File(['test'],'说明.txt',{type:'text/plain'}))
    el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))
  })
  const error = page.getByText('请选择图片或 Markdown 文件',{exact:true})
  await error.waitFor()
  await error.waitFor({state:'hidden',timeout:8000})
}, 120000)
