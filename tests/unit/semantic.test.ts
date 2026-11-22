import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'

// 向量：只在第 0 维和第 1 维有值，方便算相似度（“晴天”≈[1,0]，“夜景”≈[0,1]）
function vec(a: number, b: number): number[] {
  const v = new Array(1024).fill(0)
  v[0] = a
  v[1] = b
  return v
}
const embedCalls: string[] = []
vi.mock('../../src/main/services/ai/embeddingClient', () => ({
  embed: vi.fn(async (input: { text?: string; image?: string }) => {
    embedCalls.push(input.text ?? 'image')
    if (input.text?.includes('晴')) return vec(1, 0.1)
    if (input.text?.includes('夜')) return vec(0.1, 1)
    return vec(1, 0.05)
  })
}))
// 上传图的本地分级：可以切换成“判为 R-18”或“模型不可用”
let rating: { scores: Record<string, number>; r18: boolean } | null = { scores: {}, r18: false }
vi.mock('../../src/main/services/rating/ratingService', () => ({ rateFileNow: vi.fn(async () => rating) }))
// 对话模型：一次 search_images 只给语义描述，然后回复
const script: Array<{ content?: string; tool_calls?: unknown[] }> = []
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async () => {
    const next = script.shift() ?? { content: '好的' }
    return { message: { role: 'assistant', content: next.content ?? '', tool_calls: next.tool_calls }, finishReason: 'stop', usage: {} }
  })
}))
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))

const emb = await import('../../src/main/services/ai/embeddingService')
const { saveEmbedding } = await import('../../src/main/repositories/aiSearchRepository')
const { ask, answer } = await import('../../src/main/services/ai/assistantService')

describe('排名融合', () => {
  it('两路都靠前的排最前；只在一路的按名次', () => {
    expect(emb.rrf([[1, 2, 3], [3, 1, 4]], 10)).toEqual([1, 3, 2, 4])
    expect(emb.rrf([[], [5, 6]], 1)).toEqual([5])
  })
})

describe('语义检索和按图找相似', () => {
  let dir: string
  let pngUrl: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-sem-'))
    const source = join(dir, 'pics')
    mkdirSync(source)
    process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    pngUrl = 'data:image/png;base64,' + (await sharp({ create: { width: 64, height: 64, channels: 3, background: '#87CEEB' } }).png().toBuffer()).toString('base64')
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, display_name, thumb_ready, rating, rating_source, is_r18) VALUES
        ('h1', 'JPG', 1, 900, 600, '晴天草地', 1, 'GENERAL', 'MODEL', false),
        ('h2', 'JPG', 1, 900, 600, '星空', 1, 'GENERAL', 'MODEL', false),
        ('h3', 'JPG', 1, 900, 600, '没向量的', 1, 'GENERAL', 'MODEL', false),
        ('h4', 'JPG', 1, 900, 600, 'R18', 1, 'EXPLICIT', 'MODEL', true);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, 'a.jpg', now()), (2, 1, 'b.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.jpg', now());
    `)
    await saveEmbedding(1, 'qwen3-vl-embedding', vec(1, 0))
    await saveEmbedding(2, 'qwen3-vl-embedding', vec(0, 1))
    emb.configureEmbedding({ thumbsDir: join(dir, 'thumbs'), tempDir: join(dir, 'tmp'), canRun: () => true })
  })
  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })
  beforeEach(() => {
    embedCalls.length = 0
    rating = { scores: {}, r18: false }
  })

  it('模型只给画面描述也能找：按相似度排，对不上的不要；查询向量按原文缓存', async () => {
    const call = { tool_calls: [{ id: 's', type: 'function', function: { name: 'search_images', arguments: '{"semantic":"夜晚的星空"}' } }] }
    script.push(call, { content: '找到星空。' })
    const q = await ask({ conversationId: null, text: '有没有夜里拍天上的', scope: null, includeR18: false })
    const r = await answer(q.conversation.id)
    expect(r.images.map((i) => i.name)).toEqual(['星空'])
    expect(r.how).toBe('搜索了图库：画面「夜晚的星空」，找到 1 张')
    script.push(call, { content: '还是星空。' })
    await ask({ conversationId: q.conversation.id, text: '再来一次', scope: null, includeR18: false })
    await answer(q.conversation.id)
    expect(embedCalls).toEqual(['夜晚的星空'])
  })

  it('按图找相似：上传的图先过本地分级，判为 R-18 或判不了的不上云；没向量的图和 R-18 图不出现', async () => {
    const q = await ask({ conversationId: null, text: '', scope: null, includeR18: true, image: pngUrl })
    expect(q.message.image?.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(q.conversation.title).toBe('按图找相似')
    const r = await answer(q.conversation.id)
    expect(r.images.map((i) => i.name)).toEqual(['晴天草地'])
    expect(r.how).toBe('按你传的图找了相似的，找到 1 张')

    rating = { scores: {}, r18: true }
    await ask({ conversationId: q.conversation.id, text: '', scope: null, includeR18: false, image: pngUrl })
    await expect(answer(q.conversation.id)).rejects.toThrow('R-18')
    rating = null
    await expect(answer(q.conversation.id)).rejects.toThrow('本地分级模型')
    expect(embedCalls).toEqual(['image'])
  })

  it('补向量只做过了闸门、还没向量的图；没有字面条件的“某目录里的图”照常能找', async () => {
    const { findEmbedCandidates } = await import('../../src/main/repositories/aiSearchRepository')
    expect(await findEmbedCandidates('qwen3-vl-embedding', 10)).toEqual([3])
    const q = await ask({ conversationId: null, text: 'pics里的图', scope: null, includeR18: false })
    const r = await answer(q.conversation.id)
    expect(r.images).toHaveLength(3)
  })
})
