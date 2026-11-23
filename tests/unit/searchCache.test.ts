import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { openDatabase, getDatabase, closeDatabase } from '../../src/main/db/client'
import { cachedSearchValue, searchCacheKey } from '../../src/main/repositories/aiSearchCacheRepository'

vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async () => ({
    message: { role: 'assistant', tool_calls: [{ type: 'function', id: 'k', function: {
      name: 'search_images', arguments: JSON.stringify({ keywordGroups: [['河谷']], contrast: [] })
    } }] }, finishReason: 'stop', usage: {}
  }))
}))
vi.mock('../../src/main/services/ai/embeddingClient', () => ({ embed: vi.fn() }))
vi.mock('../../src/main/services/rating/ratingService', () => ({
  FEATURE_REVISION: 'cache-test', getVisualTagsForSearch: vi.fn(), rateFileNow: vi.fn()
}))
const { ask, answer } = await import('../../src/main/services/ai/assistantService')
const { chatCall } = await import('../../src/main/services/ai/bailianClient')
const { embed } = await import('../../src/main/services/ai/embeddingClient')
const dir = mkdtempSync(join(tmpdir(), 'ltm-cache-'))
const dbPath = join(dir, 'pgdata')
const start = () => openDatabase(dbPath, resolve('drizzle'))
const savedKey = process.env.DASHSCOPE_API_KEY
const savedPlan = process.env.ALIYUN_TOKEN_PLAN_KEY
const search = async (text: string, conversationId: number | null = null) => {
  const q = await ask({ text, conversationId, scope: null, includeR18: false })
  const reply = await answer(q.conversation.id)
  return { id: q.conversation.id, names: reply.images.map((image) => image.name).sort() }
}
beforeAll(async () => {
  process.env.DASHSCOPE_API_KEY = 'unit-test'
  process.env.ALIYUN_TOKEN_PLAN_KEY = ' '
  mkdirSync(join(dir, 'pics'))
  await start()
  const { pg } = getDatabase()
  await pg.query("INSERT INTO library_root (kind,name,path) VALUES ('CATEGORY','图库',$1)", [dir])
  await pg.exec(`
    INSERT INTO tag(name,category_id) VALUES ('琪露诺',1),('插画',4);
    INSERT INTO image(content_hash,format,byte_size,width,height,display_name,visual_features) VALUES
      ('a','PNG',1,20,20,'蓝发琪露诺','{"revision":"cache-test","tags":["blue_hair","1girl"]}'),
      ('b','PNG',1,20,20,'另一张琪露诺','{"revision":"cache-test","tags":["black_hair","1girl"]}'),
      ('c','PNG',1,20,20,'水边的少女','{"revision":"cache-test","tags":["blue_hair","1girl"]}'),
      ('d','PNG',1,20,20,'河谷','{"revision":"cache-test","tags":["landscape"]}');
    INSERT INTO image_file(image_id,root_id,rel_path,mtime) SELECT id,1,'pics/' || id || '.png',now() FROM image;
    INSERT INTO image_tag(image_id,tag_id,source,status) SELECT id,CASE WHEN id<=2 THEN 1 ELSE 2 END,'MANUAL','ACCEPTED' FROM image;`)
})
afterAll(async () => {
  await closeDatabase()
  if (savedKey === undefined) delete process.env.DASHSCOPE_API_KEY
  else process.env.DASHSCOPE_API_KEY = savedKey
  if (savedPlan === undefined) delete process.env.ALIYUN_TOKEN_PLAN_KEY
  else process.env.ALIYUN_TOKEN_PLAN_KEY = savedPlan
  rmSync(dir, { recursive: true, force: true })
})

it('跨进程复用一天内的计算，并发只执行一次，过期后重新计算', async () => {
  const key = searchCacheKey('test', '同一个问题')
  const valid = (value: unknown): value is string => typeof value === 'string'
  const load = vi.fn(async () => '新值')
  expect(await Promise.all([cachedSearchValue(key, valid, load), cachedSearchValue(key, valid, load)])).toEqual(['新值','新值'])
  await closeDatabase()
  await start()
  expect(await cachedSearchValue(key, valid, load)).toBe('新值')
  expect(load).toHaveBeenCalledTimes(1)
  await getDatabase().pg.query("UPDATE ai_search_cache SET expires_at=now()-interval '1 second' WHERE key=$1", [key])
  await cachedSearchValue(key, valid, load)
  expect(load).toHaveBeenCalledTimes(2)
})

it('重新搜索使用当天的计划，结果随当前分级和文字变化，过期后才重新调用', async () => {
  vi.mocked(chatCall).mockClear()
  const text = '想看山间流淌的河谷'
  expect((await search(text)).names).toEqual(['河谷'])
  expect((await getDatabase().pg.query("SELECT key FROM ai_search_cache WHERE key LIKE 'search-plan-%'")).rows).toHaveLength(1)
  await closeDatabase()
  await start()
  await getDatabase().pg.exec("UPDATE image SET is_r18=true WHERE id=4; UPDATE image SET description='河谷' WHERE id=3")
  process.env.ALIYUN_TOKEN_PLAN_KEY = 'local-plan-mode'
  expect((await search(text)).names).toEqual(['水边的少女'])
  expect(chatCall).toHaveBeenCalledTimes(1)
  process.env.ALIYUN_TOKEN_PLAN_KEY = ' '
  await getDatabase().pg.exec("UPDATE ai_search_cache SET expires_at=now()-interval '1 second'")
  await search(text)
  expect(chatCall).toHaveBeenCalledTimes(2)
})

it('个人套餐本地模式首次搜索发色和文字均不调用云端', async () => {
  vi.mocked(chatCall).mockClear()
  process.env.ALIYUN_TOKEN_PLAN_KEY = 'local-plan-mode'
  try {
    expect((await search('蓝色头发女孩')).names).toEqual(['水边的少女','蓝发琪露诺'])
    expect((await search('找水边的少女')).names).toEqual(['水边的少女'])
    expect((await search('找氦气深空巡航船')).names).toEqual([])
    expect(chatCall).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalled()
  } finally {
    process.env.ALIYUN_TOKEN_PLAN_KEY = ' '
  }
})

it('重启并切换到个人套餐后，仍可读取已生成的文本向量。缺少向量时不使用按量凭证', async () => {
  const { semanticVector } = await import('../../src/main/services/ai/embeddingService')
  const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)
  vi.mocked(embed).mockResolvedValue(vector)
  try {
    expect(await semanticVector('黄昏纸鸢', ['清晨纸鸢'])).toBeDefined()
    expect(embed).toHaveBeenCalledTimes(2)
    await closeDatabase()
    await start()
    process.env.ALIYUN_TOKEN_PLAN_KEY = 'local-plan-mode'
    expect(await semanticVector('黄昏纸鸢', ['清晨纸鸢'])).toBeDefined()
    expect(await semanticVector('从未检索的纸鸢', ['清晨纸鸢'])).toBeUndefined()
    expect(embed).toHaveBeenCalledTimes(2)
  } finally {
    process.env.ALIYUN_TOKEN_PLAN_KEY = ' '
    vi.mocked(embed).mockReset()
  }
})

it('按已有特征复用上一轮，同时找到之前未出现的蓝发女孩。明确限定这些图时只保留交集', async () => {
  vi.mocked(chatCall).mockClear()
  const a = await search('琪露诺')
  expect(a.names).toEqual(['另一张琪露诺','蓝发琪露诺'])
  expect((await search('蓝头发女孩子', a.id)).names).toEqual(['水边的少女','蓝发琪露诺'])
  const b = await search('琪露诺')
  expect((await search('这些图里找蓝头发女孩子', b.id)).names).toEqual(['蓝发琪露诺'])
  expect(chatCall).not.toHaveBeenCalled()
  expect(embed).not.toHaveBeenCalled()
  await getDatabase().pg.query("UPDATE ai_message SET create_time=now()-interval '2 days' WHERE conversation_id=$1", [b.id])
  expect((await search('这些图里找蓝头发女孩子', b.id)).names).toEqual([])
  expect(chatCall).not.toHaveBeenCalled()
})

it('上一轮有九张图缺少特征时，本轮只补识别八张，剩余图片保留待核对', async () => {
  const { pg } = getDatabase()
  const { followupEvidence } = await import('../../src/main/services/ai/visualFollowup')
  const { getVisualTagsForSearch } = await import('../../src/main/services/rating/ratingService')
  const rows = await pg.query<{ id: number }>(`
    INSERT INTO image(content_hash,format,byte_size,width,height,display_name)
    SELECT 'pending-' || n,'PNG',1,20,20,'待识别' FROM generate_series(1,9) AS n RETURNING id`)
  const ids = rows.rows.map((row) => row.id)
  await pg.query("INSERT INTO image_file(image_id,root_id,rel_path,mtime) SELECT i,1,'pics/' || i || '.png',now() FROM unnest($1::int[]) AS i", [ids])
  await pg.query("INSERT INTO image_tag(image_id,tag_id,source,status) SELECT i,2,'MANUAL','ACCEPTED' FROM unnest($1::int[]) AS i", [ids])
  vi.mocked(getVisualTagsForSearch).mockClear().mockResolvedValue(['blue_hair', '1girl'])
  const evidence = await followupEvidence('blue_hair', ids, undefined, ids)
  expect(getVisualTagsForSearch).toHaveBeenCalledTimes(8)
  expect(evidence.matches).toHaveLength(8)
  expect(evidence.unchecked).toHaveLength(1)
})
