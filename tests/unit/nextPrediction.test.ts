import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { insertConversation, insertMessage } from '../../src/main/repositories/aiConversationRepository'
import { findRecentTurns } from '../../src/main/repositories/aiPredictionRepository'
import { predictNext, sanitizePrediction } from '../../src/main/services/ai/nextPrediction'
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

it('sanitizePrediction 清洗引号并拦截低价值水词、多行、超长及近期重复建议', () => {
  expect(sanitizePrediction('  `只看竖图里的猫耳`  ', ['找猫耳图'])).toBe('只看竖图里的猫耳')
  expect(sanitizePrediction('“换个冷色调参考”', ['找图'])).toBe('换个冷色调参考')
  expect(sanitizePrediction('-', ['找图'])).toBeNull()
  expect(sanitizePrediction('', ['找图'])).toBeNull()
  expect(sanitizePrediction('第一行\n第二行', ['找图'])).toBeNull()
  expect(sanitizePrediction('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五', ['找图'])).toBeNull()
  expect(sanitizePrediction('这些图有哪些标签', ['找蓝色图'])).toBeNull()
  expect(sanitizePrediction('帮我介绍一下这张图', ['找蓝色图'])).toBeNull()
  expect(sanitizePrediction('还有什么可以帮你的', ['找蓝色图'])).toBeNull()
  expect(sanitizePrediction('谢谢', ['找蓝色图'])).toBeNull()
  expect(sanitizePrediction('好的！', ['找蓝色图'])).toBeNull()
  expect(sanitizePrediction('这些图有哪些标签？', ['这些图有哪些标签'])).toBeNull()
  expect(sanitizePrediction('这些图有哪些标签？', ['请问有哪些标签'])).toBe('这些图有哪些标签？')
  expect(sanitizePrediction('找蓝色的图片', ['找蓝色的图'])).toBeNull()
})

it('多轮普通对话与纯文本长回复可生成预测，并严格剔除 R-18 轮次与低价值输出', async () => {
  const c = await insertConversation('多轮轨迹测试', null)
  await insertMessage(c.id, 'USER', { text: '先看几张夜景配色参考', scope: null, includeR18: false })
  await insertMessage(c.id, 'ASSISTANT', { text: '先放这几张给你参考。', how: '找到 2 张', imageIds: [2, 3] })
  await insertMessage(c.id, 'USER', { text: 'SECRET_R18_USER_PROMPT', scope: null, includeR18: true })
  await insertMessage(c.id, 'ASSISTANT', { text: 'SECRET_R18_REPLY_NAME', how: '找到 1 张', imageIds: [99] })
  await insertMessage(c.id, 'USER', { text: '刚才冷色调和暖色调怎么选？', scope: null, includeR18: false })
  const reply = await insertMessage(c.id, 'ASSISTANT', {
    text: '如果人物主体偏亮，背景用冷色调更容易拉开层次，主体会更突出。',
    how: null,
    imageIds: []
  })

  const turns = await findRecentTurns(c.id, reply.id, 6)
  expect(turns.map((t) => t.text)).toEqual([
    '先看几张夜景配色参考',
    '先放这几张给你参考。',
    '刚才冷色调和暖色调怎么选？',
    '如果人物主体偏亮，背景用冷色调更容易拉开层次，主体会更突出。'
  ])
  expect(JSON.stringify(turns)).not.toContain('SECRET_R18')

  const callsBefore = model.mock.calls.length
  vi.stubEnv('DASHSCOPE_API_KEY', 'fixture')
  try {
    const answer = (content: string): Awaited<ReturnType<typeof chatCall>> => ({
      message: { role: 'assistant', content, refusal: null }, finishReason: 'stop',
      usage: { inputTokens: 120, outputTokens: 12, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, searchCount: 0 }
    })
    model.mockResolvedValueOnce(answer('帮我介绍一下这张图'))
    const dto = { conversationId: c.id, replyId: reply.id, scope: null, includeR18: false }
    expect(await predictNext(dto)).toBeNull()

    model.mockResolvedValueOnce(answer('用霓虹冷色举个构图例子'))
    expect(await predictNext(dto)).toBe('用霓虹冷色举个构图例子')
    expect(model).toHaveBeenCalledTimes(callsBefore + 2)

    const sentPayload = JSON.stringify(model.mock.calls[callsBefore + 1][0].messages)
    expect(sentPayload).toContain('纯文本讨论')
    expect(sentPayload).toContain('先看几张夜景配色参考')
    expect(sentPayload).not.toContain('SECRET_R18_USER_PROMPT')
    expect(sentPayload).not.toContain('SECRET_R18_REPLY_NAME')
  } finally { vi.unstubAllEnvs() }
})

it('开启包含 R-18 时可基于标签和名称元数据生成预测，且不越权泄露至普通会话', async () => {
  const { pg } = getDatabase()
  const { rows: [r18Img] } = await pg.query<{ id: number }>(
    `insert into image(content_hash,format,byte_size,display_name,is_r18) values('r18-pred','JPG',1,'夜樱私房',true) returning id`
  )
  const { rows: [r18Tag] } = await pg.query<{ id: number }>(
    `insert into tag(category_id,name) values(4,'夜樱标签') returning id`
  )
  await pg.query(`insert into image_file(image_id,root_id,rel_path,mtime) values($1,1,'角色/夜樱私房.jpg',now())`, [r18Img.id])
  await pg.query(`insert into image_tag(image_id,tag_id,status,source) values($1,$2,'ACCEPTED','MANUAL')`, [r18Img.id, r18Tag.id])

  const c = await insertConversation('R-18 预测测试', null)
  await insertMessage(c.id, 'USER', { text: '找夜樱私房的标签参考', scope: null, includeR18: true })
  const r18Reply = await insertMessage(c.id, 'ASSISTANT', { text: '', how: '找到 1 张', imageIds: [r18Img.id] })
  const callsBefore = model.mock.calls.length
  vi.stubEnv('DASHSCOPE_API_KEY', 'fixture')
  try {
    model.mockResolvedValueOnce({
      message: { role: 'assistant', content: '按夜樱标签筛选同系列图片', refusal: null },
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, imageTokens: 0, searchCount: 0 }
    })
    expect(await predictNext({ conversationId: c.id, replyId: r18Reply.id, scope: null, includeR18: true })).toBe('按夜樱标签筛选同系列图片')
    expect(JSON.stringify(model.mock.calls[callsBefore][0].messages)).toContain('夜樱标签')
    expect(await predictNext({ conversationId: c.id, replyId: r18Reply.id, scope: null, includeR18: false })).toBeNull()
  } finally { vi.unstubAllEnvs() }
})
