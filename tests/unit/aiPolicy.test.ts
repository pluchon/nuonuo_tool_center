import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { getAiPolicy, changePreference, reserveEmbedding, setEmbeddingLimit } from '../../src/main/services/ai/aiPolicy'
import { dreamOnce } from '../../src/main/services/ai/dreamService'
import { configureEmbedding, isEmbedBusy, scheduleEmbedding, stopEmbedding, uploadVector } from '../../src/main/services/ai/embeddingService'
import * as imageRecords from '../../src/main/repositories/aiResultRepository'
import * as search from '../../src/main/repositories/aiSearchRepository'
import * as prep from '../../src/main/services/ai/imagePrep'
import { readSetting, upsertSettings } from '../../src/main/repositories/appSettingRepository'
import { chatCall } from '../../src/main/services/ai/bailianClient'
import { embed } from '../../src/main/services/ai/embeddingClient'
import { rateFileNow } from '../../src/main/services/rating/ratingService'

vi.mock('electron', () => ({nativeImage:{},clipboard:{}}))
vi.mock('../../src/main/services/ai/bailianClient', () => ({ chatCall:vi.fn(async () => ({message:{content:'图库偏好摘要'}})) }))
vi.mock('../../src/main/services/ai/embeddingClient', () => ({embed:vi.fn(async () => Array.from({length:1024},(_,i)=>Number(i===0)))}))
vi.mock('../../src/main/services/rating/ratingService', () => ({rateFileNow:vi.fn(async () => ({r18:false}))}))
const dir = mkdtempSync(join(tmpdir(),'nono-policy-'))
const open = () => openDatabase(join(dir,'db'),resolve('drizzle'))
const original = process.env.DASHSCOPE_API_KEY
beforeAll(async () => {
  process.env.DASHSCOPE_API_KEY = 'fixture-policy'
  await open()
  configureEmbedding({ thumbsDir:dir,tempDir:join(dir,'uploads'),canRun:()=>false })
})
afterAll(async () => {
  await stopEmbedding()
  if (original === undefined) delete process.env.DASHSCOPE_API_KEY
  else process.env.DASHSCOPE_API_KEY = original
  await closeDatabase()
  rmSync(dir,{recursive:true,force:true})
})

it('并行预留受同一日上限约束；重启延续计数，次日重新计数，零可暂停', async () => {
  expect(await reserveEmbedding('d0')).toBe(false)
  await setEmbeddingLimit(-1)
  for (let i = 0; i < 53; i++) expect(await reserveEmbedding('d0')).toBe(true)
  await setEmbeddingLimit(2)
  expect((await Promise.all([reserveEmbedding('d1'),reserveEmbedding('d1'),reserveEmbedding('d1')])).filter(Boolean)).toHaveLength(2)
  await closeDatabase(); await open()
  expect(await reserveEmbedding('d1')).toBe(false)
  expect(await reserveEmbedding('d2')).toBe(true)
  await setEmbeddingLimit(0)
  expect(await reserveEmbedding('d3')).toBe(false)
})

it('同一图像跨重启复用向量，重新分级后拒绝缓存结果，云端命中与本地次数分别统计', async () => {
  const image = 'data:image/jpeg;base64,' + Buffer.from('字节样本').toString('base64')
  await uploadVector(image)
  await closeDatabase(); await open()
  await uploadVector(image)
  expect(embed).toHaveBeenCalledTimes(1)
  expect(rateFileNow).toHaveBeenCalledTimes(2)
  vi.mocked(rateFileNow).mockResolvedValueOnce({r18:true} as Awaited<ReturnType<typeof rateFileNow>>)
  await expect(uploadVector(image)).rejects.toThrow('R-18')
  await getDatabase().pg.exec("insert into api_usage(api,cached_tokens) values('chat',37)")
  expect(await getAiPolicy()).toMatchObject({localHits:1,cloudCachedTokens:37})
})

it('用户纠正推断后旧行为不再产生同一偏好，管理入口可查看并忘记明确偏好', async () => {
  const { pg } = getDatabase()
  await pg.exec(`insert into ai_event(kind,payload) select 'suggestion.reject','{"kind":"tag","value":"小猫"}'::jsonb from generate_series(1,3)`)
  await dreamOnce(true)
  const initial = (await getAiPolicy()).preferences[0]
  expect(initial).toMatchObject({content:'不要用「小猫」当标签',explicit:false})
  await changePreference(initial.id,'猫咪标签保留')
  await pg.exec("insert into ai_event(kind,payload) values('unrelated','{}')")
  await dreamOnce(true)
  const revised = (await getAiPolicy()).preferences
  expect(revised).toHaveLength(1)
  expect(revised[0]).toMatchObject({content:'猫咪标签保留',explicit:true})
  await changePreference(revised[0].id,null)
  expect((await getAiPolicy()).preferences).toEqual([])
  expect((await pg.query("select content from ai_profile where content<>''")).rows).toEqual([])
})

it('摘要忽略无效内容和时间戳，故障退避跨重启，鉴权失败只在密钥更新后重试', async () => {
  const {pg} = getDatabase()
  await pg.exec("insert into ai_memory(content,kind,confidence) values('测试偏好','preference',0.8),('弱推断','rule',0.1)")
  const mock = vi.mocked(chatCall)
  mock.mockClear()
  mock.mockRejectedValueOnce(Object.assign(new Error('busy'),{status:429}))
  await dreamOnce(true)
  const retry = await readSetting<{retryAt:number}>('ai.dream.summary')
  expect(retry!.retryAt).toBeGreaterThan(Date.now())
  await closeDatabase(); await open()
  await dreamOnce(true)
  expect(mock).toHaveBeenCalledTimes(1)
  await upsertSettings([{key:'ai.dream.summary',value:{retryAt:0,failed:1}}])
  mock.mockRejectedValueOnce(Object.assign(new Error('bad key'),{status:401}))
  await dreamOnce(true); await dreamOnce(true)
  expect(mock).toHaveBeenCalledTimes(2)
  process.env.DASHSCOPE_API_KEY = 'fixture-updated'
  await dreamOnce(true)
  expect(mock).toHaveBeenCalledTimes(3)
  expect(mock.mock.calls[2][0].maxTokens).toBe(640)
  expect(JSON.stringify(mock.mock.calls[2][0].messages)).not.toContain('弱推断')
  const state = await readSetting<Record<string,unknown>>('ai.dream.summary')
  await upsertSettings([{key:'ai.dream.summary',value:{...state,lastSuccess:0}}])
  await getDatabase().pg.exec('update ai_memory set update_time=now()')
  await dreamOnce(true)
  expect(mock).toHaveBeenCalledTimes(3)
})

it('前台开始操作后只完成已发出的向量请求，恢复后继续且遵守每日上限', async () => {
  const processed: number[] = []
  const ids = [301,302,303]
  vi.spyOn(search,'findEmbedCandidates').mockImplementation(async (_model,_limit,id) =>
    ids.filter((n) => !processed.includes(n) && (id === undefined || id === n)))
  vi.spyOn(imageRecords,'findLookInfo').mockResolvedValue({cloudAllowed:true} as NonNullable<Awaited<ReturnType<typeof imageRecords.findLookInfo>>>)
  vi.spyOn(prep,'prepareImage').mockResolvedValue('data:image/jpeg;base64,AQ==')
  vi.spyOn(search,'saveEmbedding').mockImplementation(async (id) => { processed.push(id) })
  let foreground = false
  let release!: () => void
  const first = new Promise<void>((resolve) => { release = resolve })
  let sent!: () => void
  const dispatched = new Promise<void>((resolve) => { sent = resolve })
  vi.mocked(embed).mockImplementationOnce(async () => { sent(); await first; return Array(1024).fill(0) })
  configureEmbedding({thumbsDir:dir,tempDir:dir,canRun:()=>!foreground})
  await setEmbeddingLimit(2)
  scheduleEmbedding()
  await dispatched
  foreground = true
  release()
  await vi.waitFor(() => expect(isEmbedBusy()).toBe(false))
  expect(processed).toEqual([301])
  foreground = false
  scheduleEmbedding()
  await vi.waitFor(() => expect(isEmbedBusy()).toBe(false))
  expect(processed).toEqual([301,302])
  expect((await getAiPolicy()).dailyUsed).toBe(2)
})

it('空闲整理按模型返回的等义关系合并，保留原文、主体不同的偏好和手工纠正', async () => {
  const {pg} = getDatabase()
  const {insertConversation,insertMessage} = await import('../../src/main/repositories/aiConversationRepository')
  const c = await insertConversation('记忆整理',null)
  const q = await insertMessage(c.id,'USER',{text:'我喜欢猫耳角色'})
  const ids: number[] = []
  for (const content of ['喜欢猫耳角色','偏爱长猫耳的人物','诺诺喜欢猫耳','保留限定细节']) {
    const {rows} = await pg.query<{id:number}>("insert into ai_memory(content,kind,confidence,source_message_id) values($1,'preference',0.9,$2) returning id",[content,ids.length===3?null:q.id])
    ids.push(Number(rows[0].id))
  }
  const [keep, duplicate,,manual] = ids
  const mock = vi.mocked(chatCall)
  mock.mockResolvedValueOnce({message:{content:JSON.stringify({summary:'喜欢猫耳角色',duplicates:[[keep,duplicate],[keep,manual],[keep,12345678]]})}} as Awaited<ReturnType<typeof chatCall>>)
  await upsertSettings([{key:'ai.dream.summary',value:{}}])
  await dreamOnce(true)
  const rows = await pg.query<{id:number; active:boolean}>('select id,valid_to is null as active from ai_memory where id=any($1::bigint[]) order by id',[ids])
  expect(rows.rows.map(r=>r.active)).toEqual([true,false,true,true])
})
