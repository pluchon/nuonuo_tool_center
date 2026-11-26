import {mkdirSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {afterEach, expect, it} from 'vitest'
import {openDatabase, closeDatabase} from '../../src/main/db/client'
import {closeLeftoverApps, freshCase, launchApp} from './support/app'

afterEach(closeLeftoverApps)
it('在 AI 设置展示后台画面索引与用量统计并保存每日上限，且不渲染长期记忆或偏好控制', async () => {
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
  expect(await first.page.getByRole('region', { name: '后台画面索引' }).isVisible()).toBe(true)
  expect(await first.page.getByRole('region', { name: '用量统计' }).isVisible()).toBe(true)
  expect(await first.page.getByRole('region', { name: '长期记忆' }).count()).toBe(0)
  expect(await first.page.getByText('长期记忆', { exact: true }).count()).toBe(0)
  expect(await first.page.getByText('测试推断', { exact: true }).count()).toBe(0)
  expect(await first.page.getByRole('button', { name: '纠正', exact: true }).count()).toBe(0)
  expect(await first.page.getByRole('button', { name: '忘记', exact: true }).count()).toBe(0)
  expect(await first.page.getByLabel('偏好内容').count()).toBe(0)
  expect(await first.page.getByRole('button', { name: '下次重新规划', exact: true }).count()).toBe(0)
  const rightEdges = await first.page.locator('.set-dlg__group[aria-label="后台画面索引"] .set-dlg__ctl > :last-child').evaluateAll(
    elements => elements.map(el => el.getBoundingClientRect().right))
  expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(1)
  expect(await first.page.getByRole('button',{name:'暂停',exact:true}).getAttribute('aria-pressed')).toBe('true')
  await first.page.getByRole('button',{name:'每日限量',exact:true}).click()
  const limit = first.page.getByLabel('后台向量每日上限')
  await limit.fill('750')
  await limit.press('Tab')
  await expect.poll(async () => (await first.page.evaluate(() => window.api.ai.policy())).data?.dailyLimit).toBe(750)
  await first.app.close()
  const next = await open()
  expect(await next.page.getByLabel('后台向量每日上限').inputValue()).toBe('750')
  expect(await next.page.getByRole('region', { name: '后台画面索引' }).isVisible()).toBe(true)
  expect(await next.page.getByRole('region', { name: '用量统计' }).isVisible()).toBe(true)
  expect(await next.page.getByText('总 Tokens', { exact: true }).isVisible()).toBe(true)
  expect(await next.page.getByText('估算费用', { exact: true }).isVisible()).toBe(true)
  expect(await next.page.getByText('云端缓存', { exact: true }).isVisible()).toBe(true)
  expect(await next.page.getByText('调用次数', { exact: true }).isVisible()).toBe(true)
  await next.page.getByRole('tab', { name: '趋势柱图', exact: true }).click()
  expect(await next.page.getByRole('img', { name: 'Token消耗趋势堆叠柱状图' }).isVisible()).toBe(true)
  await next.page.getByRole('tab', { name: '效率雷达', exact: true }).click()
  expect(await next.page.getByRole('img', { name: 'AI省流与效率五维雷达图' }).isVisible()).toBe(true)
  expect(await next.page.getByRole('region', { name: '长期记忆' }).count()).toBe(0)
  expect(await next.page.getByRole('button', { name: '纠正', exact: true }).count()).toBe(0)
  expect(await next.page.getByRole('button', { name: '忘记', exact: true }).count()).toBe(0)
  await next.page.getByRole('button', { name: '不限量', exact: true }).click()
  await expect.poll(async () => (await next.page.evaluate(() => window.api.ai.policy())).data?.dailyLimit).toBe(-1)
  await next.page.getByRole('button', { name: '每日限量', exact: true }).click()
  await expect.poll(async () => (await next.page.evaluate(() => window.api.ai.policy())).data?.dailyLimit).toBe(0)
  expect(await next.page.getByLabel('后台向量每日上限').inputValue()).toBe('')
},100000)
