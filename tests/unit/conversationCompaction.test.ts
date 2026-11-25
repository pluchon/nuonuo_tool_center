import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import {
  findCompactionMap,
  findCompactionsByConversation,
  findLatestCompaction,
  findMessages,
  insertConversation,
  insertMessage
} from '../../src/main/repositories/aiConversationRepository'
import { workingHistory, type HistoryTurn } from '../../src/main/services/ai/conversationCompaction'
import { chatCall } from '../../src/main/services/ai/bailianClient'

vi.mock('../../src/main/services/ai/bailianClient', () => ({ chatCall: vi.fn() }))
const temp = mkdtempSync(join(tmpdir(), 'ltm-compact-'))
beforeAll(() => openDatabase(join(temp,'pg'), resolve('drizzle')))
afterAll(async () => { await closeDatabase(); rmSync(temp,{recursive:true,force:true}) })

it('接近上限时自动分批精简，故障后复用已保存的摘要，保留最近的原文', async () => {
  const c = await insertConversation('精简',null)
  const turns: HistoryTurn[] = []
  for (let i=0; i<8; i++) {
    const payload = '甲'.repeat(24000)
    await insertMessage(c.id,'USER',{text:payload})
    const row = await insertMessage(c.id,'ASSISTANT',{text:'回答'})
    turns.push({id:row.id,messages:[{role:'user',content:payload},{role:'assistant',content:'回答'}]})
  }
  const mock = vi.mocked(chatCall)
  const response = {message:{content:'合并后的摘要'},finishReason:'stop'} as Awaited<ReturnType<typeof chatCall>>
  mock.mockResolvedValue(response)
  // 首批包含四轮，每个分段独立生成；下一批暂时失败。
  mock.mockResolvedValueOnce(response).mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('断网'))
  const progress = vi.fn()
  await expect(workingHistory(turns,3000,false,progress)).rejects.toThrow('断网')
  expect(progress.mock.calls).toEqual([[true],[false]])
  const rows = await findMessages(c.id)
  expect(rows.every(row => !(row.content as {compactSummary?:string}).compactSummary)).toBe(true)
  const compactions = await findCompactionsByConversation(c.id)
  expect(compactions.length).toBeGreaterThan(0)
  expect(compactions[0].summary).toBe('合并后的摘要')
  expect((await findLatestCompaction(c.id))?.summary).toBe('合并后的摘要')
  expect((await findCompactionMap(compactions.map((item) => item.upToMessageId))).get(compactions[0].upToMessageId)).toBe('合并后的摘要')
  const result = await workingHistory(turns,3000,false)
  expect(JSON.stringify(result.messages.slice(0, 2))).toContain('合并后的摘要')
  expect(result.messages.at(-1)).toEqual(turns.at(-1)?.messages.at(-1))
  expect(rows).toHaveLength(16)
  await workingHistory(turns,0,true)
  mock.mockClear()
  expect((await workingHistory(turns,0,true)).changed).toBe(false)
  expect(mock).not.toHaveBeenCalled()
})
