import { afterEach, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import { freshCase, closeLeftoverApps } from './support/app'
import { bailianRequests, launchWithMockBailian } from './support/mockBailian'

afterEach(closeLeftoverApps)

it('根据当前图片生成短预测，Tab 保留图片；连续忽略后暂停提示', async () => {
  const dirs = freshCase('assistant-local-prediction')
  mkdirSync(dirs.data, { recursive: true })
  mkdirSync(join(dirs.library, '配色'), { recursive: true })
  const { pg } = await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
  try {
    await pg.query("insert into library_root(kind,name,path,last_scan_at) values('CATEGORY','类目录',$1,now())", [dirs.library])
    await pg.exec(`
      insert into image(content_hash,format,byte_size,display_name,is_r18,rating_source)
        values ('pred-one','JPG',1,'第一幅',false,'MANUAL'), ('pred-two','JPG',1,'第二幅',false,'MANUAL');
      insert into image_file(image_id,root_id,rel_path,mtime) select id,1,'配色/'||content_hash||'.jpg',now() from image;
      insert into tag(category_id,name) values(4,'蓝色');
      insert into image_tag(image_id,tag_id,status,source) select id,1,'ACCEPTED','MANUAL' from image;
      insert into ai_conversation(title) values('测试预测');
      insert into ai_message(conversation_id,role,content) values
        (1,'USER','{"text":"找蓝色图","scope":null,"includeR18":false}'),
        (1,'ASSISTANT','{"text":"","how":"按标签检索，找到 2 张","imageIds":[1,2]}');`)
  } finally { await closeDatabase() }
  const { app, page } = await launchWithMockBailian(dirs)
  await app.evaluate(() => {
    const fetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const body = await request.clone().json()
      if (body.max_tokens !== 40) return fetch(request)
      const data = JSON.parse(body.messages.at(-1).content)
      const names = data.图片样本.map((r: { 名称: string }) => r.名称)
      const subject = names.join('和')
      const content = data.来源 === '当前选图' ? '说说' + subject + '的蓝色' : '哪幅的蓝色更醒目？'
      return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })
    }
  })
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }) })
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  await page.getByRole('button', { name: '对话记录' }).click()
  await page.locator('.assistant__hist-row').first().click()
  const input = page.locator('.assistant__input')
  const hint = page.locator('.assistant__prediction')
  await hint.filter({ hasText: '哪幅的蓝色更醒目？' }).waitFor()
  const refs = page.locator('.assistant__composer .image-references__item')
  const drag = async (index: number) => {
    const card = page.locator('.assistant__pic').nth(index)
    await card.dispatchEvent('pointerdown', { button: 0 })
    await page.waitForTimeout(400)
    const data = await page.evaluateHandle(() => new DataTransfer())
    await card.dispatchEvent('dragstart', { dataTransfer: data })
    await page.locator('.assistant__composer').dispatchEvent('drop', { dataTransfer: data })
    await data.dispose()
  }
  await drag(1)
  await hint.filter({ hasText: '说说第二幅的蓝色' }).waitFor()
  await drag(0)
  await hint.filter({ hasText: '说说第二幅和第一幅的蓝色' }).waitFor()
  await input.press('Tab')
  expect(await input.inputValue()).toBe('说说第二幅和第一幅的蓝色')
  expect(await refs.locator('.image-references__open').evaluateAll(nodes => nodes.map(el => el.getAttribute('aria-label'))))
    .toEqual(['查看大图 第二幅', '查看大图 第一幅'])
  expect(await page.locator('.assistant__reply').count()).toBe(1)
  await input.fill('比较这两张图的共同标签')
  await input.press('Enter')
  await page.getByText('共同标签：蓝色。', { exact: true }).waitFor()
  await drag(0)
  await hint.waitFor()
  await input.press('Escape')
  await drag(1)
  await hint.waitFor()
  await input.press('Escape')
  await page.getByRole('button', { name: '移除引用 第一幅' }).click()
  await page.waitForTimeout(900)
  expect(await hint.count()).toBe(0)
  expect(await bailianRequests(app)).not.toContain('completions')
}, 90_000)

it('可见时预测，输入法和切换范围安全，Tab 只填入，忽略和采纳能在重开对话后保留', async () => {
  const { app, page } = await launchWithMockBailian(freshCase('assistant-next-prediction'))
  await app.evaluate(() => {
    const counters = { predictions: 0, replies: 0 }
    Object.assign(globalThis, { predictionCounts: counters })
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (!new URL(request.url).pathname.endsWith('/chat/completions')) throw new Error('拒绝其他请求')
      const body = await request.json() as { max_tokens?: number }
      let content = '可以从两种配色思路开始讨论。'
      if (body.max_tokens === 40) {
        counters.predictions++
        await new Promise((resolve) => setTimeout(resolve, 180))
        content = '比较这两种配色思路'
      } else counters.replies++
      const message = body.max_tokens === 40 ? { role: 'assistant', content } : {
        role: 'assistant', tool_calls: [{ id: 'discussion', type: 'function', function: {
          name: 'reply_with_followup', arguments: JSON.stringify({ answer: content, suggestion: counters.replies === 1 ? '比较这两种配色思路' : '用暖色举个例子' })
        } }]
      }
      return Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 2400, completion_tokens: 18, prompt_tokens_details: { cached_tokens: 1500 } } })
    }
  })
  const counts = () => app.evaluate(() => (globalThis as typeof globalThis & { predictionCounts: { predictions: number; replies: number } }).predictionCounts)
  const visibility = (hidden: boolean) => page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
  await visibility(true)
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  const input = page.locator('.assistant__input')
  const hint = page.locator('.assistant__prediction')
  await input.fill('如何设计插画的配色？')
  await input.press('Enter')
  await page.locator('.assistant__reply').first().waitFor()
  await page.waitForTimeout(850)
  expect(await counts()).toEqual({ predictions: 0, replies: 1 })
  await visibility(false)
  await hint.waitFor()
  await page.getByRole('switch', { name: '包含 R-18' }).click()
  await page.waitForTimeout(250)
  expect(await hint.count()).toBe(0)
  await page.getByRole('switch', { name: '包含 R-18' }).click()
  await hint.waitFor()
  expect(await hint.innerText()).toContain('按 Tab 键生效')
  await input.dispatchEvent('compositionstart')
  await input.dispatchEvent('keydown', { key: 'Tab', isComposing: true })
  expect(await input.inputValue()).toBe('')
  await input.dispatchEvent('compositionend')
  await hint.waitFor()
  await input.press('Tab')
  expect(await input.inputValue()).toBe('比较这两种配色思路')
  expect(await counts()).toEqual({ predictions: 0, replies: 1 })
  await input.press('Enter')
  await expect.poll(() => page.locator('.assistant__reply').count()).toBe(2)
  await hint.waitFor()
  await input.fill('自行输入')
  await hint.waitFor({ state: 'detached' })
  await input.fill('')
  await page.getByRole('button', { name: '新对话' }).click()
  await page.getByRole('button', { name: '对话记录' }).click()
  await page.locator('.assistant__hist-row').first().click()
  await page.waitForTimeout(900)
  expect(await hint.count()).toBe(0)
  expect(await counts()).toEqual({ predictions: 0, replies: 2 })
}, 90_000)
