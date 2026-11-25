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
const search = async (text: string, conversationId: number | null = null) => {
  const q = await ask({ text, conversationId, scope: null, includeR18: false })
  const reply = await answer(q.conversation.id)
  return { id: q.conversation.id, names: reply.images.map((image) => image.name).sort() }
}
beforeAll(async () => {
  process.env.DASHSCOPE_API_KEY = 'unit-test'
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

it('并发失败可重试，无效结果不写入，损坏的旧缓存可由新结果替换', async () => {
  const key = searchCacheKey('test', '异常重试')
  const valid = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('断网')).mockResolvedValueOnce('').mockResolvedValue('恢复')
  const calls = await Promise.allSettled(Array.from({ length: 12 }, () => cachedSearchValue(key, valid, load)))
  expect(calls.every(r => r.status === 'rejected')).toBe(true)
  expect(load).toHaveBeenCalledTimes(1)
  expect(await cachedSearchValue(key, valid, load)).toBeUndefined()
  const { pg } = getDatabase()
  expect((await pg.query('select key from ai_search_cache where key=$1', [key])).rows).toHaveLength(0)
  await pg.query("insert into ai_search_cache(key,value,expires_at) values($1,'{}',now()+interval '1 day')", [key])
  expect(await cachedSearchValue(key, valid, load)).toBe('恢复')
  expect(await cachedSearchValue(key, valid, load)).toBe('恢复')
  expect(load).toHaveBeenCalledTimes(3)
})

it('关闭旧图库后才返回的请求，不会把结果写到新图库', async () => {
  const key = searchCacheKey('test', '延迟响应')
  const valid = (v: unknown): v is string => typeof v === 'string'
  let started!: () => void
  let finish!: (s: string) => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const late = new Promise<string>(resolve => { finish = resolve })
  const old = cachedSearchValue(key, valid, async () => { started(); return late })
  await entered
  await closeDatabase()
  try {
    await openDatabase(join(dir, '另一个图库'), resolve('drizzle'))
    finish('旧图库结果')
    expect(await old).toBe('旧图库结果')
    expect(await cachedSearchValue(key, valid, async () => '新图库结果')).toBe('新图库结果')
  } finally {
    finish('旧图库结果')
    await closeDatabase()
    await start()
  }
})

it('缓存达到容量上限时清理过期条目，保留新写入的结果', async () => {
  const { pg } = getDatabase()
  await pg.exec(`insert into ai_search_cache(key,value,expires_at)
    select 'capacity-test:' || n, '1', now() + n * interval '1 second' from generate_series(-2,1005) n`)
  try {
    const key = 'capacity-test:new'
    const valid = (v: unknown): v is number => typeof v === 'number'
    const load = vi.fn(async () => 2)
    await cachedSearchValue(key, valid, load)
    expect((await pg.query('select count(*)::int as n from ai_search_cache')).rows).toEqual([{ n: 1000 }])
    expect((await pg.query('select key from ai_search_cache where expires_at <= now()')).rows).toEqual([])
    expect(await cachedSearchValue(key, valid, load)).toBe(2)
    expect(load).toHaveBeenCalledTimes(1)
  } finally {
    await pg.exec("delete from ai_search_cache where key like 'capacity-test:%'")
  }
})

it('重新搜索使用当天的计划，结果随当前分级和文字变化，过期后才重新调用', async () => {
  vi.mocked(chatCall).mockClear()
  const text = '想看山间流淌的河谷'
  expect((await search(text)).names).toEqual(['河谷'])
  expect((await getDatabase().pg.query("SELECT key FROM ai_search_cache WHERE key LIKE 'search-plan-%'")).rows).toHaveLength(1)
  await closeDatabase()
  await start()
  await getDatabase().pg.exec("UPDATE image SET is_r18=true WHERE id=4; UPDATE image SET description='河谷' WHERE id=3")
  process.env.DASHSCOPE_API_KEY = ' '
  expect((await search(text)).names).toEqual(['水边的少女'])
  expect(chatCall).toHaveBeenCalledTimes(1)
  process.env.DASHSCOPE_API_KEY = 'unit-test'
  await getDatabase().pg.exec("UPDATE ai_search_cache SET expires_at=now()-interval '1 second'")
  await search(text)
  expect(chatCall).toHaveBeenCalledTimes(2)
})

it('缺少百炼密钥时本地文字检索不调用云端', async () => {
  vi.mocked(chatCall).mockClear()
  process.env.DASHSCOPE_API_KEY = ' '
  try {
    expect((await search('找水边的少女')).names).toEqual(['水边的少女'])
    expect((await search('找氦气深空巡航船')).names).toEqual([])
    expect(chatCall).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalled()
  } finally {
    process.env.DASHSCOPE_API_KEY = 'unit-test'
  }
})

it('重启后即使缺少百炼密钥，仍可读取已生成的文本向量。缺少向量时不发起请求', async () => {
  const { semanticVector } = await import('../../src/main/services/ai/embeddingService')
  const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)
  vi.mocked(embed).mockResolvedValue(vector)
  try {
    expect(await semanticVector('黄昏纸鸢', ['清晨纸鸢'])).toBeDefined()
    expect(embed).toHaveBeenCalledTimes(2)
    await closeDatabase()
    await start()
    process.env.DASHSCOPE_API_KEY = ' '
    expect(await semanticVector('黄昏纸鸢', ['清晨纸鸢'])).toBeDefined()
    expect(await semanticVector('从未检索的纸鸢', ['清晨纸鸢'])).toBeUndefined()
    expect(embed).toHaveBeenCalledTimes(2)
  } finally {
    process.env.DASHSCOPE_API_KEY = 'unit-test'
    vi.mocked(embed).mockReset()
  }
})

it('动态视觉过滤结合已有特征复用上一轮，明确限定这些图时只保留交集', async () => {
  vi.mocked(chatCall).mockClear()
  const a = await search('琪露诺')
  expect(a.names).toEqual(['另一张琪露诺','蓝发琪露诺'])
  vi.mocked(chatCall).mockResolvedValueOnce({
    message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', id: 'v1', function: {
      name: 'search_images', arguments: JSON.stringify({ visualInclude: ['blue_hair', '1girl'], contrast: [] })
    } }] }, finishReason: 'stop', usage: {}
  } as never)
  expect((await search('蓝头发女孩子', a.id)).names).toEqual(['水边的少女','蓝发琪露诺'])
  const b = await search('琪露诺')
  vi.mocked(chatCall).mockResolvedValueOnce({
    message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', id: 'v2', function: {
      name: 'search_images', arguments: JSON.stringify({ visualInclude: ['blue_hair', '1girl'], contrast: [] })
    } }] }, finishReason: 'stop', usage: {}
  } as never)
  expect((await search('这些图里找蓝头发女孩子', b.id)).names).toEqual(['蓝发琪露诺'])
  expect(embed).not.toHaveBeenCalled()
  await getDatabase().pg.query("UPDATE ai_message SET create_time=now()-interval '2 days' WHERE conversation_id=$1", [b.id])
  expect((await search('这些图里找蓝头发女孩子', b.id)).names).toEqual([])
})

it('通用视觉匹配按上限补检缺失特征，同时支持包含与排除标签过滤', async () => {
  const { pg } = getDatabase()
  const { matchVisualFeatures } = await import('../../src/main/services/ai/search/visualMatcher')
  const { getVisualTagsForSearch } = await import('../../src/main/services/rating/ratingService')
  const rows = await pg.query<{ id: number }>(`
    INSERT INTO image(content_hash,format,byte_size,width,height,display_name)
    SELECT 'pending-' || n,'PNG',1,20,20,'待识别' FROM generate_series(1,9) AS n RETURNING id`)
  const ids = rows.rows.map((row) => row.id)
  try {
    await pg.query("INSERT INTO image_file(image_id,root_id,rel_path,mtime) SELECT i,1,'pics/' || i || '.png',now() FROM unnest($1::int[]) AS i", [ids])
    await pg.query("INSERT INTO image_tag(image_id,tag_id,source,status) SELECT i,2,'MANUAL','ACCEPTED' FROM unnest($1::int[]) AS i", [ids])
    vi.mocked(getVisualTagsForSearch).mockClear()
      .mockResolvedValueOnce(['blue_hair', '1girl', 'fox_ears'])
      .mockResolvedValue(['blue_hair', '1girl'])
    const evidence = await matchVisualFeatures(ids, { include: ['blue_hair', '1girl'], exclude: ['fox_ears'] }, ids)
    expect(getVisualTagsForSearch).toHaveBeenCalledTimes(8)
    expect(evidence.matches).toHaveLength(7)
    expect(evidence.unchecked).toHaveLength(1)
  } finally {
    await pg.query("UPDATE image SET delete_state = 1 WHERE content_hash LIKE 'pending-%'")
  }
})
