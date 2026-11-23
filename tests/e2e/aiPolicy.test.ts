import {mkdirSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {afterEach, expect, it} from 'vitest'
import {openDatabase, closeDatabase} from '../../src/main/db/client'
import {closeLeftoverApps, freshCase, launchApp} from './support/app'

afterEach(closeLeftoverApps)
it('在 AI 设置调整每日上限、纠正和忘记推断偏好，重新打开后设置生效', async () => {
  const dirs = freshCase('policy-settings')
  mkdirSync(dirs.data,{recursive:true})
  const {pg} = await openDatabase(join(dirs.data,'pgdata'),resolve('drizzle'))
  try { await pg.exec("insert into ai_memory(content,kind,confidence) values('测试推断','rule',0.7)") }
  finally { await closeDatabase() }
  const open = async () => {
    const desktop = await launchApp(dirs,{LTM_E2E_HIDDEN:'1',DASHSCOPE_API_KEY:' ',ALIYUN_TOKEN_PLAN_KEY:' '})
    await desktop.page.locator('.title-bar__gear').click()
    await desktop.page.getByRole('tab',{name:'AI',exact:true}).click()
    await desktop.page.getByRole('group', {name:'云端处理'}).waitFor()
    return desktop
  }
  const first = await open()
  expect(await first.page.getByRole('button',{name:'暂停',exact:true}).getAttribute('aria-pressed')).toBe('true')
  await first.page.getByRole('button',{name:'每日限量',exact:true}).click()
  const limit = first.page.getByLabel('后台向量每日上限')
  await limit.fill('750')
  await limit.press('Tab')
  await first.page.getByRole('button',{name:'纠正'}).click()
  const editor = first.page.getByLabel('偏好内容')
  await editor.fill(' ')
  await editor.press('Enter')
  expect(await first.page.getByRole('alert').count()).toBe(0)
  await editor.fill('尚在选词')
  const composingHandled = await editor.evaluate((input) =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
  expect(composingHandled).toBe(true)
  expect((await first.page.evaluate(() => window.api.ai.policy())).data?.preferences[0].content).toBe('测试推断')
  await editor.fill('测试明确偏好')
  await editor.press('Enter')
  await first.page.getByText('用户明说',{exact:true}).waitFor()
  await first.app.close()
  const next = await open()
  expect(await next.page.getByLabel('后台向量每日上限').inputValue()).toBe('750')
  await next.page.getByText('测试明确偏好',{exact:true}).waitFor()
  await next.page.getByRole('button',{name:'忘记'}).click()
  await next.page.getByText('暂无记忆',{exact:true}).waitFor()
  expect(await next.page.getByText('云端前缀缓存命中',{exact:true}).isVisible()).toBe(true)
  await next.page.getByRole('button', { name: '不限量', exact: true }).click()
  await expect.poll(async () => (await next.page.evaluate(() => window.api.ai.policy())).data?.dailyLimit).toBe(-1)
  await next.page.getByRole('button', { name: '每日限量', exact: true }).click()
  await expect.poll(async () => (await next.page.evaluate(() => window.api.ai.policy())).data?.dailyLimit).toBe(0)
  expect(await next.page.getByLabel('后台向量每日上限').inputValue()).toBe('')
},100000)
