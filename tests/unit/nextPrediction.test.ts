import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { insertConversation, insertMessage } from '../../src/main/repositories/aiConversationRepository'
import { predictNext } from '../../src/main/services/ai/nextPrediction'
import { chatCall } from '../../src/main/services/ai/bailianClient'

vi.mock('../../src/main/services/ai/bailianClient', () => ({ chatCall: vi.fn() }))
const model = vi.mocked(chatCall)
const root = mkdtempSync(join(tmpdir(), 'ltm-predict-'))
beforeAll(async () => {
  await openDatabase(join(root, 'pg'), resolve('drizzle'))
})
afterAll(async () => {
  await closeDatabase()
  rmSync(root, { recursive: true, force: true })
})

async function round(content: Record<string, unknown>) {
  const c = await insertConversation('预测测试', null)
  await insertMessage(c.id, 'USER', { text: '如何安排色彩？', scope: null, includeR18: false })
  const a = await insertMessage(c.id, 'ASSISTANT', content)
  return { conversationId: c.id, replyId: a.id, scope: null, includeR18: false }
}

it('建议可重复读取，切换检索范围或继续对话后不再返回旧建议', async () => {
  const dto = await round({ text: '可以先规划主色。', nextPrediction: '比较两种配色方案' })
  expect(await Promise.all([predictNext(dto), predictNext(dto)])).toEqual(['比较两种配色方案', '比较两种配色方案'])
  expect(await predictNext({ ...dto, includeR18: true })).toBeNull()
  expect(await predictNext({ ...dto, scope: { kind: 'category', name: '其他' } })).toBeNull()
  await insertMessage(dto.conversationId, 'USER', { text: '新消息' })
  expect(await predictNext(dto)).toBeNull()
  expect(model).not.toHaveBeenCalled()
})

it('普通回复和旧版未生成的建议不会触发额外模型调用', async () => {
  expect(await predictNext(await round({ text: '你好。' }))).toBeNull()
  expect(await predictNext(await round({ text: '历史回复', predictionPrefix: 'old' }))).toBeNull()
  expect(model).not.toHaveBeenCalled()
})

it('按普通图片与偏好生成有界预测，并发和重开复用，分级变化后立即失效', async () => {
  const { pg } = getDatabase()
  await pg.exec(`insert into library_root(kind,name,path) values('CATEGORY','测试','fixture');
    insert into image(content_hash,format,byte_size,display_name,is_r18) values('prediction','JPG',1,'猫耳少女',false);
    insert into image_file(image_id,root_id,rel_path,mtime) values(1,1,'角色/猫耳少女.jpg',now());
    insert into tag(category_id,name) values(4,'粉色睡衣');
    insert into image_tag(image_id,tag_id,status,source) values(1,1,'ACCEPTED','MANUAL')`)
  const dto = await round({ text: '', how: '找到 1 张', imageIds: [1] })
  vi.stubEnv('DASHSCOPE_API_KEY', 'fixture')
  try {
    const answer = (content: string): Awaited<ReturnType<typeof chatCall>> => ({
      message: { role: 'assistant', content, refusal: null }, finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, searchCount: 0 }
    })
    model.mockResolvedValueOnce(answer('粉色睡衣适合搭配什么背景？'))
    const twin = await round({ text: '', how: '找到 1 张', imageIds: [1] })
    const [first, second] = await Promise.all([predictNext(dto), predictNext(twin)])
    expect(first).toBe('粉色睡衣适合搭配什么背景？')
    expect(second).toBe(first)
    expect(await predictNext(dto)).toBe(first)
    expect(model).toHaveBeenCalledTimes(1)
    expect(model.mock.calls[0][0]).toMatchObject({ kind: 'predict', maxTokens: 40 })
    expect(JSON.stringify(model.mock.calls[0][0].messages)).toContain('粉色睡衣')
    vi.stubEnv('DASHSCOPE_API_KEY', ' ')
    await closeDatabase()
    await openDatabase(join(root, 'pg'), resolve('drizzle'))
    const current = getDatabase().pg
    expect(await predictNext(twin)).toBe(first)
    await current.exec("update tag set name='蓝色睡衣' where id=1")
    expect(await predictNext(twin)).toBeNull()
    expect(model).toHaveBeenCalledTimes(1)
    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture')
    model.mockResolvedValueOnce(answer('残缺\n两行'))
    expect(await predictNext(twin)).toBeNull()
    model.mockResolvedValueOnce(answer('蓝色睡衣配什么背景？'))
    expect(await predictNext(twin)).toBe('蓝色睡衣配什么背景？')
    expect(await predictNext(twin)).toBe('蓝色睡衣配什么背景？')
    expect(model).toHaveBeenCalledTimes(3)
    const alternate = await round({ text: '这次只讨论背景。', how: '找到 1 张', imageIds: [1] })
    model.mockResolvedValueOnce(answer('-'))
    expect(await predictNext(alternate)).toBeNull()
    expect(await predictNext(alternate)).toBeNull()
    expect(model).toHaveBeenCalledTimes(4)
    await current.exec('update image set is_r18=true where id=1')
    expect(await predictNext(dto)).toBeNull()
    expect(model).toHaveBeenCalledTimes(4)
  } finally { vi.unstubAllEnvs() }
})
