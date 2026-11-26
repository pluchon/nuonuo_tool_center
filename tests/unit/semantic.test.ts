import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
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
    if (input.text === '蓝发少女' || input.text === '相同分数的轮廓') return vec(1, 1)
    if (input.text === '红发少女') return vec(0, 1)
    if (input.text === '相似耳形') return vec(0.701, 0.713)
    if (input.text === '白发少女') throw new Error('模拟对照查询超时')
    if (input.text?.includes('晴')) return vec(1, 0.1)
    if (input.text?.includes('夜')) return vec(0.1, 1)
    return vec(1, 0.05)
  })
}))
// 上传图的本地分级：可以切换成“判为 R-18”或“模型不可用”
let rating: { scores: Record<string, number>; r18: boolean } | null = { scores: {}, r18: false }
vi.mock('../../src/main/services/rating/ratingService', () => ({
  FEATURE_REVISION: 'semantic-test',
  rateFileNow: vi.fn(async () => rating),
  getVisualTagsForSearch: vi.fn<(id: number) => Promise<string[] | null>>()
}))
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
const { findIndexedUpload, saveEmbedding } = await import('../../src/main/repositories/aiSearchRepository')
const { ask, answer, listMessages } = await import('../../src/main/services/ai/assistantService')

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
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', '类目录', $1)`, [dir])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, display_name, thumb_ready, rating, rating_source, is_r18) VALUES
        ('h1', 'JPG', 1, 900, 600, '晴天草地', 1, 'GENERAL', 'MODEL', false),
        ('h2', 'JPG', 1, 900, 600, '星空', 1, 'GENERAL', 'MODEL', false),
        ('h3', 'JPG', 1, 900, 600, '没向量的', 1, 'GENERAL', 'MODEL', false),
        ('h4', 'JPG', 1, 900, 600, '蓝发女孩子', 1, 'EXPLICIT', 'MODEL', true),
        ('h5', 'JPG', 1, 900, 600, '未标记', 1, 'GENERAL', 'MODEL', false),
        ('h6', 'JPG', 1, 900, 600, '有标签但待复核', 1, 'GENERAL', 'MODEL', false);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT id, 1, 'pics/' || id::text || '.jpg', now() FROM image;
      INSERT INTO tag (name, category_id) VALUES ('照片', 4), ('蓝发', 4);
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES
        (1, 1, 'MANUAL', 'ACCEPTED'), (2, 1, 'MANUAL', 'ACCEPTED'), (3, 1, 'VLM', 'ACCEPTED'),
        (4, 2, 'MANUAL', 'ACCEPTED'), (5, 1, 'VLM', 'SUGGESTED'), (6, 1, 'MANUAL', 'ACCEPTED');
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status) VALUES (6, 'IDENTIFY', 'test', '{}', '{"name":"PENDING"}');
    `)
    await saveEmbedding(1, 'qwen3-vl-embedding', vec(1, 0))
    await saveEmbedding(2, 'qwen3-vl-embedding', vec(0, 1))
    for (const id of [4, 5, 6]) await saveEmbedding(id, 'qwen3-vl-embedding', vec(0, 1))
    emb.configureEmbedding({ thumbsDir: join(dir, 'thumbs'), tempDir: join(dir, 'tmp'), canRun: () => true })
  })
  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  it('上传原件只复用当前类目录内已确认普通图的同模型向量', async () => {
    const model = 'qwen3-vl-embedding'
    expect(await findIndexedUpload('h1', model, [{ rootId: 1, prefix: 'pics' }])).toEqual(vec(1, 0))
    expect(await findIndexedUpload('h1', model, [{ rootId: 1, prefix: '其他' }])).toBeUndefined()
    expect(await findIndexedUpload('h1', '另一个模型', undefined)).toBeUndefined()
    for (const hash of ['h3', 'h4', 'h5', 'h6']) {
      expect(await findIndexedUpload(hash, model, undefined)).toBeUndefined()
    }
  })
  beforeEach(() => {
    embedCalls.length = 0
    rating = { scores: {}, r18: false }
  })

  it('无标签提示时也可比较画面与近似反例，重复查询复用文本向量', async () => {
    const call = { tool_calls: [{ id: 's', type: 'function', function: { name: 'search_images', arguments: '{"semantic":"夜晚的星空","contrast":["白天的天空"]}' } }] }
    script.push(call)
    const q = await ask({ conversationId: null, text: '有没有夜里拍天上的', scope: null, includeR18: false })
    const r = await answer(q.conversation.id)
    expect(r.images.map((i) => i.name)).toEqual(['星空'])
    expect(r.how).toBe('搜索了图库：画面「夜晚的星空」。目前显示 1 张，部分图片尚无画面向量。')
    script.push(call)
    await ask({ conversationId: q.conversation.id, text: '再来一次', scope: null, includeR18: false })
    await answer(q.conversation.id)
    expect(embedCalls).toEqual(['夜晚的星空', '白天的天空'])
  })

  it('普通图片须同时超过绝对门槛和近似反例；查询重复使用缓存，反例失败时不放宽条件', async () => {
    const { searchImages } = await import('../../src/main/repositories/aiSearchRepository')
    const search = async (contrast: string[]) => {
      const vector = await emb.semanticVector('蓝发少女', contrast)
      expect(vector).toBeDefined()
      return (await searchImages({ r18: 'exclude', vector, tagGroups: [], keywordGroups: [] })).ids
    }
    // 两张普通图与正向描述的余弦都是 0.707；第二张与红发描述完全一致。
    expect(await Promise.all([search(['红发少女', '蓝发少女', '红发少女']), search(['红发少女'])])).toEqual([[1], [1]])
    expect(embedCalls).toEqual(['蓝发少女', '红发少女'])
    expect(await search(['相同分数的轮廓'])).toEqual([])
    expect(await search(['相似耳形'])).toEqual([])
    expect(await emb.semanticVector('蓝发少女', ['白发少女'])).toBeUndefined()
    const weak = vec(0.44, 0.44)
    weak[2] = Math.sqrt(1 - 2 * 0.44 ** 2)
    const filter = await emb.semanticVector('蓝发少女', ['红发少女'])
    expect((await searchImages({ r18: 'exclude', vector: { ...filter!, values: weak }, tagGroups: [], keywordGroups: [] })).ids).toEqual([])
    // 同是中等相似度，只有能明显区分发色的候选才能命中。
    const scores = (a: number, b: number): number[] => {
      const v = vec(a, b)
      v[2] = Math.sqrt(1 - a * a - b * b)
      return v
    }
    const idsFor = async (other: number[]) => (await searchImages({
      r18: 'exclude', tagGroups: [], keywordGroups: [],
      vector: { ...filter!, values: scores(0.48, 0.47), contrast: { ...filter!.contrast!, values: [other] } }
    })).ids
    expect(await idsFor(scores(0.35, 0.36))).toEqual([1, 2])
    expect(await idsFor(scores(0.35, 0.43))).toEqual([1])
  })

  it('缺少有效反例时跳过向量接口，按原句去重并限制反例数量', async () => {
    for (const raw of [undefined, [], [' ', '！？', '猫 耳少女！'], [null, 0]]) {
      expect(await emb.semanticVector('猫耳少女', raw)).toBeUndefined()
    }
    expect(embedCalls).toEqual([])
    expect(emb.contrastDescriptions('猫耳少女', ['兔耳少女', '兔耳少女。', '狐耳少女', '普通人耳少女'])).toEqual(['兔耳少女', '狐耳少女'])
  })

  it('按图找相似：上传的图先过本地分级，判为 R-18 或判不了的不上云；没向量的图和 R-18 图不出现', async () => {
    const q = await ask({ conversationId: null, text: '', scope: null, includeR18: true, image: pngUrl })
    expect(q.message.image?.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(q.message.attachment).toEqual({ kind: 'image', name: '', mimeType: 'image/png', dataUrl: q.message.image })
    expect(q.conversation.title).toBe('按图找相似')
    // 还原旧版本写入的 JSON，确认重启后的历史显示和图片检索都能读取它。
    await getDatabase().pg.query('UPDATE ai_message SET content = $1::jsonb WHERE id = $2', [
      JSON.stringify({ text: '', scope: null, includeR18: true, image: q.message.image }), q.message.id
    ])
    expect((await listMessages(q.conversation.id))[0].attachment).toEqual({
      kind: 'image', name: '', mimeType: 'image/jpeg', dataUrl: q.message.image
    })
    const r = await answer(q.conversation.id)
    expect(r.images.map((i) => i.name)).toEqual(['晴天草地'])
    expect(r.how).toBe('按你传的图找了相似的。目前显示 1 张，部分图片尚无画面向量。')

    rating = { scores: {}, r18: true }
    const uploaded = await ask({ conversationId: q.conversation.id, text: '', scope: null, includeR18: false,
      attachment: { kind: 'image', name: '示例.png', mimeType: 'image/png', dataUrl: pngUrl } })
    expect(uploaded.message.attachment).toMatchObject({ kind: 'image', name: '示例.png', mimeType: 'image/png' })
    await expect(answer(q.conversation.id)).rejects.toThrow('R-18')
    rating = null
    await expect(answer(q.conversation.id)).rejects.toThrow('本地分级模型')
    expect(embedCalls).toEqual(['image'])
  })

  it('双附件按 Markdown 看图，分级失败、模型拒绝和图库人工分级均在本地阻止上传，重试保留原消息', async () => {
    const { chatCall } = await import('../../src/main/services/ai/bailianClient')
    const chat = vi.mocked(chatCall)
    chat.mockClear()
    const prompt = { kind: 'markdown' as const, name: '颜色.md', text: '只回答图片的主色。' }
    const picture = { kind: 'image' as const, name: '背景.png', mimeType: 'image/png', dataUrl: pngUrl }
    const base = { conversationId: null, text: '', scope: null, includeR18: true }
    for (const attachments of [[prompt, prompt], [picture, picture], [prompt, picture, prompt]]) {
      await expect(ask({ ...base, attachments })).rejects.toThrow()
    }
    const q = await ask({ ...base, attachments: [prompt, picture] })
    expect(q.message.attachments).toEqual([prompt, { ...picture, dataUrl: q.message.image }])
    const id = q.conversation.id
    rating = null
    await expect(answer(id)).rejects.toThrow('本地分级模型')
    rating = { scores: {}, r18: true }
    await expect(answer(id)).rejects.toThrow('R-18')
    rating = { scores: {}, r18: false }
    const hash = createHash('sha256').update(Buffer.from(pngUrl.split(',')[1], 'base64')).digest('hex')
    const { pg } = getDatabase()
    await pg.query('INSERT INTO image (content_hash, format, byte_size, is_r18) VALUES ($1, $2, 42, true)', [hash, 'PNG'])
    await expect(answer(id)).rejects.toThrow('R-18')
    await pg.query('DELETE FROM image WHERE content_hash = $1', [hash])
    expect(chat).not.toHaveBeenCalled()
    expect(await listMessages(id)).toEqual([q.message])
    script.push({ content: '蓝色' })
    expect((await answer(id)).text).toBe('蓝色')
    expect(chat).toHaveBeenCalledTimes(1)
    const payload = chat.mock.calls[0][0]
    expect(payload.tools).toBeUndefined()
    expect(payload.messages.at(-1)).toEqual({ role: 'user', content: [
      { type: 'image_url', image_url: { url: q.message.image } },
      { type: 'text', text: expect.stringContaining(prompt.text) }
    ] })
    expect(embedCalls).toEqual([])
    await ask({ ...base, conversationId: id, text: '刚才的答案是什么？' })
    await answer(id)
    const followup = JSON.stringify(chat.mock.calls[1][0].messages)
    expect(followup).toContain(prompt.text)
    expect(followup).not.toContain('base64,')
  })

  it('模型直接报数量时按本轮原文实际检索，R-18 只命中本地元数据，复核状态在历史卡片中也生效', async () => {
    script.push(
      { content: '找到 100 张。（给用户看了 12 张图：#99「不真实.jpg」）' },
      { tool_calls: [{ id: 'verify', type: 'function', function: { name: 'search_images', arguments: '{"contrast":["红发少女"]}' } }] }
    )
    const q = await ask({ conversationId: null, text: '蓝发女孩子', scope: null, includeR18: true })
    const reply = await answer(q.conversation.id)
    expect(reply.images.map((i) => i.imageId)).toEqual([4, 1])
    expect(reply.text).not.toMatch(/100|给用户|不真实|R-18/)
    const { pg } = getDatabase()
    await pg.exec("INSERT INTO image_ai_result (image_id, kind, model, result, field_status) VALUES (4,'IDENTIFY','test','{}','{\"r18Review\":\"PENDING\"}')")
    try {
      expect((await listMessages(q.conversation.id)).at(-1)?.images.map((i) => i.imageId)).toEqual([1])
    } finally {
      await pg.exec("UPDATE image_ai_result SET field_status = '{\"r18Review\":\"ACCEPTED\"}' WHERE image_id = 4")
    }
    expect((await listMessages(q.conversation.id)).at(-1)?.images.map((i) => i.imageId)).toEqual([4, 1])
  })

  it('两次漏传对照时只核对原有元数据条件，图片向量即便相似也不补入结果', async () => {
    const chat = vi.mocked((await import('../../src/main/services/ai/bailianClient')).chatCall)
    chat.mockClear()
    const lookup = (args: object) => ({ tool_calls: [{ id: 's', type: 'function', function: { name: 'search_images', arguments: JSON.stringify(args) } }] })
    script.push(
      lookup({ semantic: '蓝发女孩子', keywordGroups: [['蓝发'], ['女孩']] }),
      lookup({ keywordGroups: [['女孩']] }),
      { content: '目前先按文字条件找到这张啦~' }
    )
    const q = await ask({ conversationId: null, text: '按这一句描述搜索', scope: null, includeR18: true })
    const reply = await answer(q.conversation.id)
    expect(reply.images.map((item) => item.imageId)).toEqual([4])
    expect(reply.how).not.toContain('画面「')
    expect(reply.how).toContain('目前显示 1 张，画面相似度检索暂不可用')
    expect(chat).toHaveBeenCalledTimes(3)
    expect(embedCalls).toEqual([])
  })

  it('字面匹配要求每组特征同时成立，不匹配父目录名，零命中不自动删减条件', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      UPDATE image SET description = CASE id WHEN 1 THEN '蓝色头发的少女' WHEN 2 THEN '红发女孩' WHEN 3 THEN '蓝发男孩' END WHERE id IN (1,2,3);
      UPDATE image_file SET rel_path = '蓝发/' || rel_path WHERE image_id = 2
    `)
    const search = async (groups: string[][], includeR18: boolean) => {
      script.push({ tool_calls: [{ id: 'filter', type: 'function', function: {
        name: 'search_images', arguments: JSON.stringify({ keywordGroups: groups })
      } }] })
      const q = await ask({ conversationId: null, text: '按要求筛选一下', scope: null, includeR18 })
      return (await answer(q.conversation.id)).images.map((item) => item.imageId)
    }
    try {
      const features = [['蓝发', '蓝色头发'], ['女孩', '少女']]
      expect(await search(features, true)).toEqual([1, 4])
      expect(await search([...features, ['宇航服']], true)).toEqual([])
    } finally {
      await pg.exec("UPDATE image SET description = NULL WHERE id IN (1,2,3); UPDATE image_file SET rel_path = 'pics/2.jpg' WHERE image_id = 2")
    }
  })

  it('猫娘查询排除相似度相同的蝴蝶结和狐耳，保留文字确认和本地识别的猫耳', async () => {
    const { pg } = getDatabase()
    const root = { id: 1 }
    const names = ['琪露诺坐姿', '撑伞的兽耳少女', '猫耳少女', '草地上的少女', '兽耳少女', '兽耳合影', '庭院里的女孩']
    const ids: number[] = []
    for (const [index, name] of names.entries()) {
      const { rows: [item] } = await pg.query<{ id: number }>(
        "INSERT INTO image (content_hash,format,byte_size,display_name,is_r18) VALUES ($1,'PNG',1,$2,$3) RETURNING id",
        ['ears-' + index, name, index === 5]
      )
      ids.push(item.id)
      await pg.query("INSERT INTO image_file (image_id,root_id,rel_path,mtime) VALUES ($1,$2,$3,now())", [item.id, root.id, '插画/' + index + '.png'])
      await pg.query("INSERT INTO image_tag (image_id,tag_id,source,status) VALUES ($1,1,'MANUAL','ACCEPTED')", [item.id])
      if (index !== 5) await saveEmbedding(item.id, 'qwen3-vl-embedding', vec(1, 0))
    }
    const { rows: [catTag] } = await pg.query<{ id: number }>("INSERT INTO tag (name,category_id) VALUES ('猫耳角色',4) RETURNING id")
    await pg.query("INSERT INTO tag_alias (tag_id,name) VALUES ($1,'猫娘')", [catTag.id])
    await pg.query("INSERT INTO image_tag (image_id,tag_id,source,status) VALUES ($1,$2,'MANUAL','ACCEPTED')", [ids[6], catTag.id])
    const { getVisualTagsForSearch } = await import('../../src/main/services/rating/ratingService')
    const traits = vi.mocked(getVisualTagsForSearch)
    traits.mockImplementation(async (id) => new Map([
      [ids[0], ['hair_bow']], [ids[1], ['animal_ears','fox_ears']], [ids[3], ['cat_ears']]
    ]).get(id) ?? null)
    try {
      const scope = { kind: 'category' as const, name: '插画' }
      const { chatCall } = await import('../../src/main/services/ai/bailianClient')
      vi.mocked(chatCall).mockClear()
      // 离线模式下精确标签快路径直接本地处理，不调用云端
      process.env.DASHSCOPE_API_KEY = ' '
      try {
        for (const [word, expected] of [['猫娘', [ids[6]]], ['草地上的少女', []]] as const) {
          const q = await ask({ conversationId: null, text: `找标签为${word}的图`, scope, includeR18: true })
          expect((await answer(q.conversation.id)).images.map((item) => item.imageId)).toEqual(expected)
        }
        expect(chatCall).not.toHaveBeenCalled()
        expect(embedCalls).toEqual([])
      } finally {
        process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
      }
      script.push({ tool_calls: [{ id: 'ears', type: 'function', function: { name: 'search_images',
        arguments: JSON.stringify({ keywordGroups: [['猫娘','猫耳少女']], visualInclude: ['cat_ears'], semantic: '猫耳少女', contrast: ['夜景'] })
      } }] })
      const q = await ask({ conversationId: null, text: '想看猫娘', scope, includeR18: true })
      const result = await answer(q.conversation.id)
      expect(vi.mocked(chatCall).mock.calls[0][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({
        function: expect.objectContaining({ name: 'search_images' })
      })]))
      expect(result.images.map((item) => item.imageId)).toEqual([ids[6], ids[2], ids[3]])
      expect(traits).not.toHaveBeenCalledWith(ids[2])
      expect(traits).not.toHaveBeenCalledWith(ids[5])
    } finally {
      await pg.query("UPDATE image SET delete_state=1 WHERE content_hash LIKE 'ears-%'")
      await pg.query('UPDATE tag SET delete_state=1 WHERE id=$1', [catTag.id])
      traits.mockReset()
      script.length = 0
    }
  })

  it('每组条件都有已确认标签或别名时优先展示，其次是文字、最后是纯视觉结果，历史卡片保持顺序', async () => {
    const { pg } = getDatabase()
    const root = { id: 1 }
    const { rows: [bird] } = await pg.query<{ id: number }>("INSERT INTO tag (name,category_id) VALUES ('白鹭',4) RETURNING id")
    const { rows: [lake] } = await pg.query<{ id: number }>("INSERT INTO tag (name,category_id) VALUES ('湖畔',4) RETURNING id")
    await pg.query("INSERT INTO tag_alias (tag_id,name) VALUES ($1,'水边')", [lake.id])
    const pictures = [
      { name: '晨光', tags: [lake.id, bird.id], r18: false, description: null },
      { name: '暮色', tags: [lake.id, bird.id], r18: true, description: null },
      { name: '水面', tags: [lake.id], r18: false, description: '白鹭' },
      { name: '暖冬', tags: [1], r18: true, description: '水边的白鹭' },
      { name: '栖息', tags: [1], r18: false, description: null }
    ]
    try {
      for (const picture of pictures) {
        const { rows: [item] } = await pg.query<{ id: number }>(
          "INSERT INTO image (content_hash,format,byte_size,display_name,description,is_r18) VALUES ($1,'PNG',1,$2,$3,$4) RETURNING id",
          ['egret-' + picture.name, picture.name, picture.description, picture.r18]
        )
        await pg.query("INSERT INTO image_file (image_id,root_id,rel_path,mtime) VALUES ($1,$2,$3,now())", [item.id, root.id, '白鹭观察/' + item.id + '.png'])
        for (const tagId of picture.tags) {
          await pg.query("INSERT INTO image_tag (image_id,tag_id,source,status) VALUES ($1,$2,'MANUAL','ACCEPTED')", [item.id, tagId])
        }
        if (!picture.r18) await saveEmbedding(item.id, 'qwen3-vl-embedding', vec(1, 0))
      }
      const groups = [['白鹭'], ['水边']]
      for (const includeR18 of [true, false]) {
        script.push({ tool_calls: [{ id: 'egret', type: 'function', function: { name: 'search_images',
          arguments: JSON.stringify({ tags: ['白鹭'], keywordGroups: groups, semantic: '在岸边的白鹭', contrast: ['夜里的海鸥'] })
        } }] })
        const q = await ask({ conversationId: null, text: '想看在岸边站着的白鹭', scope: { kind: 'category', name: '白鹭观察' }, includeR18 })
        const result = await answer(q.conversation.id)
        const expected = pictures.filter((p) => includeR18 || !p.r18).map((p) => p.name)
        expect(result.images.map((i) => i.name)).toEqual(expected)
        expect((await listMessages(q.conversation.id)).at(-1)?.images.map((i) => i.name)).toEqual(expected)
      }
    } finally {
      script.length = 0
      await pg.query("UPDATE image SET delete_state=1 WHERE content_hash LIKE 'egret-%'")
      await pg.query('UPDATE tag SET delete_state=1 WHERE id IN ($1,$2)', [bird.id, lake.id])
    }
  })

  it('补向量只做过了闸门、还没向量的图；没有字面条件的“某目录里的图”照常能找', async () => {
    const { findEmbedCandidates } = await import('../../src/main/repositories/aiSearchRepository')
    expect(await findEmbedCandidates('qwen3-vl-embedding', 10)).toEqual([3])
    const { pg } = getDatabase()
    await pg.exec(`insert into ai_job (kind, image_id, status) values ('LOOK', 3, 'QUEUED')`)
    expect(await findEmbedCandidates('qwen3-vl-embedding', 10)).toEqual([])
    await pg.exec(`update ai_job set status = 'RUNNING' where kind = 'LOOK' and image_id = 3`)
    expect(await findEmbedCandidates('qwen3-vl-embedding', 10)).toEqual([])
    await pg.exec(`update ai_job set status = 'DONE' where kind = 'LOOK' and image_id = 3`)
    expect(await findEmbedCandidates('qwen3-vl-embedding', 10)).toEqual([3])
    script.push(
      { tool_calls: [{ id: 'dir', type: 'function', function: { name: 'search_images', arguments: '{"browseScope":true,"contrast":[]}' } }] },
      { content: 'pics 里的图都在这儿啦~' }
    )
    const q = await ask({ conversationId: null, text: 'pics里的图', scope: { kind: 'category', name: 'pics' }, includeR18: false })
    const r = await answer(q.conversation.id)
    expect(r.images).toHaveLength(3)
    process.env.DASHSCOPE_API_KEY = ' '
    try {
      const offline = await ask({ conversationId: null, text: 'pics里的图', scope: null, includeR18: false })
      expect((await answer(offline.conversation.id)).images).toHaveLength(3)
    } finally {
      process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    }
  })

  it('文字与向量均命中超过十二张时，返回全部匹配并按并集准确计数', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name)
        SELECT 'union-' || n, 'JPG', 1, CASE WHEN n <= 13 THEN '紫云' ELSE '紫霞' END FROM generate_series(1,26) n;
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT id, 1, 'pics/' || content_hash || '.jpg', now() FROM image WHERE content_hash LIKE 'union-%';
      INSERT INTO image_tag (image_id, tag_id, source, status) SELECT id, 1, 'MANUAL', 'ACCEPTED' FROM image WHERE content_hash LIKE 'union-%';
      INSERT INTO image_embedding (image_id, model, embedding)
        SELECT id, 'qwen3-vl-embedding', (SELECT embedding FROM image_embedding WHERE image_id = 1) FROM image WHERE display_name = '紫霞' OR content_hash = 'union-1';`)
    try {
      script.push({ tool_calls: [{ id: 's', type: 'function', function: { name: 'search_images', arguments: '{"keywordGroups":[["紫云"]],"semantic":"紫云景色","contrast":["夜晚的黑云"]}' } }] })
      const q = await ask({ conversationId: null, text: '想看看紫云景色', scope: null, includeR18: false })
      const result = await answer(q.conversation.id)
      expect(result.images).toHaveLength(27)
      expect(new Set(result.images.map((image) => image.imageId)).size).toBe(27)
      expect(result.how).toContain('目前显示 27 张')
    } finally {
      await pg.exec("UPDATE image SET delete_state = 1 WHERE content_hash LIKE 'union-%'")
    }
  })

  it('退出时中断正在进行的后台向量请求，并等待任务结束', async () => {
    const jpeg = await sharp(Buffer.from(pngUrl.split(',')[1], 'base64')).jpeg().toBuffer()
    writeFileSync(join(dir, 'pics', '3.jpg'), jpeg)
    await getDatabase().pg.query('update image set content_hash=$1 where id=3', [createHash('sha256').update(jpeg).digest('hex')])
    const { embed } = await import('../../src/main/services/ai/embeddingClient')
    let activeSignal: AbortSignal | undefined
    vi.mocked(embed).mockImplementationOnce(async (_input, _id, signal) => {
      activeSignal = signal
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    await (await import('../../src/main/services/ai/aiPolicy')).setEmbeddingLimit(1)
    emb.scheduleEmbedding()
    try {
      await vi.waitFor(() => expect(activeSignal).toBeDefined())
    } finally {
      await emb.stopEmbedding()
    }
    expect(activeSignal?.aborted).toBe(true)
    expect(emb.isEmbedBusy()).toBe(false)
  })
})
