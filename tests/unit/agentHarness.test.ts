import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { microcompactTail } from '../../src/main/services/ai/harness/context'
import { defineTool, dispatchTool, validateToolArgs } from '../../src/main/services/ai/harness/toolRegistry'
import { createInitialHarnessState } from '../../src/main/services/ai/harness/types'
import { evaluateVisualTags, normalizeVisualTags } from '../../src/main/services/ai/search/visualMatcher'

const script: Array<{ content?: string; tool_calls?: unknown[] }> = []
vi.mock('../../src/main/services/ai/embeddingClient', () => ({
  embed: vi.fn(async () => {
    throw new Error('测试向量服务不可用')
  })
}))
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async () => {
    const next = script.shift() ?? { content: '好的' }
    return {
      message: { role: 'assistant', content: next.content ?? '', tool_calls: next.tool_calls },
      finishReason: 'stop',
      usage: {}
    }
  })
}))
vi.mock('../../src/main/services/rating/ratingService', () => ({
  FEATURE_REVISION: 'harness-test',
  getVisualTagsForSearch: vi.fn(async () => null),
  rateFileNow: vi.fn(async () => null)
}))

const { ask, answer } = await import('../../src/main/services/ai/assistantService')

describe('ToolRegistry 单源校验与 Microcompaction', () => {
  it('按同一份 Schema 校验合法参数、坏 JSON、缺必填项、类型不符和未知工具', async () => {
    const sample = defineTool({
      name: 'sample_tool',
      description: '测试工具',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1 },
          tags: { type: 'array', maxItems: 2, items: { type: 'string' } }
        }
      },
      execute: (args) => ({ content: JSON.stringify({ ok: true, args }) })
    })
    const map = new Map([[sample.name, sample]])
    const env = {
      userText: '',
      query: '',
      hasInputContext: false,
      tags: [],
      dirs: undefined,
      includeR18: false,
      userMessageId: 1,
      readReferences: async () => []
    }
    const state = createInitialHarnessState(false, false)

    expect(validateToolArgs(sample.parameters, '{bad').ok).toBe(false)
    expect(validateToolArgs(sample.parameters, '[]').ok).toBe(false)
    expect(validateToolArgs(sample.parameters, '{}')).toEqual({ ok: false, error: '缺少必填参数 query' })
    expect(validateToolArgs(sample.parameters, '{"query":"a","limit":0}')).toEqual({ ok: false, error: '参数 limit 不能小于 1' })
    expect(validateToolArgs(sample.parameters, '{"query":"a","tags":["1","2","3"]}')).toEqual({
      ok: false,
      error: '参数 tags 最多 2 项'
    })

    const unknown = await dispatchTool(map, 'nope', '{}', env, state)
    expect(JSON.parse(unknown.content)).toEqual({ error: '没有 nope 这个工具' })

    const ok = await dispatchTool(map, 'sample_tool', '{"query":"蓝发","limit":5}', env, state)
    expect(JSON.parse(ok.content)).toEqual({ ok: true, args: { query: '蓝发', limit: 5 } })
  })

  it('microcompactTail 折叠更早步骤中冗长的 tool 输出，保留最近一步完整结果', () => {
    const longBody = JSON.stringify({ images: Array.from({ length: 40 }, (_, i) => ({ id: i, name: '图' + i })) })
    const tail = [
      { role: 'user' as const, content: '问题' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 't1' }] },
      { role: 'tool' as const, tool_call_id: 't1', content: longBody },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 't2' }] },
      { role: 'tool' as const, tool_call_id: 't2', content: longBody }
    ]
    const compacted = microcompactTail(tail, 200)
    expect(compacted[2].content).toContain('"compacted":true')
    expect(compacted[2].content).toContain(`"originalBytes":${Buffer.byteLength(longBody)}`)
    expect(compacted[4].content).toBe(longBody)
    // 原数组不被修改
    expect(tail[2].content).toBe(longBody)
  })

  it('normalizeVisualTags 与 evaluateVisualTags 通用支持任意 Danbooru 标签包含与排除', () => {
    expect(normalizeVisualTags([' Glasses ', 'school uniform', 'BAD TAG!', 'glasses'])).toEqual(['glasses', 'school_uniform'])
    expect(evaluateVisualTags(['1girl', 'glasses', 'school_uniform'], { include: ['glasses', 'school_uniform'], exclude: ['fox_ears'] })).toBe(true)
    expect(evaluateVisualTags(['1girl', 'glasses', 'fox_ears'], { include: ['glasses'], exclude: ['fox_ears'] })).toBe(false)
    expect(evaluateVisualTags(['1girl', 'glasses', '1boy'], { include: ['glasses'], ambiguous: ['1boy'] })).toBeNull()
  })
})

describe('AgentHarness 集成动态工具与通用视觉过滤', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-harness-'))
    const lib = join(dir, 'pics')
    mkdirSync(lib, { recursive: true })
    process.env.DASHSCOPE_API_KEY = 'test-key-harness'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query("INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', '类目录', $1)", [lib])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, display_name, visual_features) VALUES
        ('g1', 'PNG', 10, 100, 100, '眼镜学妹', '{"revision":"harness-test","tags":["1girl","glasses","school_uniform"]}'),
        ('g2', 'PNG', 10, 100, 100, '眼镜狐娘', '{"revision":"harness-test","tags":["1girl","glasses","fox_ears"]}'),
        ('g3', 'PNG', 10, 100, 100, '运动少女', '{"revision":"harness-test","tags":["1girl","track_jacket"]}');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, 1, '二次元/' || content_hash || '.png', now() FROM image;
      INSERT INTO tag (name, category_id) VALUES ('插画', 4);
      INSERT INTO image_tag (image_id, tag_id, source, status)
        SELECT id, 1, 'MANUAL', 'ACCEPTED' FROM image;
    `)
  })

  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  beforeEach(() => {
    script.length = 0
  })

  it('通过 visualInclude 与 visualExclude 动态过滤任意视觉特征（眼镜且不含狐耳）', async () => {
    script.push({
      tool_calls: [
        {
          id: 's1',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({ visualInclude: ['glasses'], visualExclude: ['fox_ears'], contrast: [] })
          }
        }
      ]
    })
    const q = await ask({ conversationId: null, text: '找戴眼镜但不要狐耳的图', scope: null, includeR18: false })
    const r = await answer(q.conversation.id)
    expect(r.images.map((i) => i.name)).toEqual(['眼镜学妹'])
    expect(r.how).toContain('画面特征「glasses」')
    expect(r.how).toContain('排除特征「fox_ears」')
  })

  it('支持通过工具动态解释命中依据，以及单次与永久排除结果图', async () => {
    script.push({
      tool_calls: [
        {
          id: 's2',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({ visualInclude: ['glasses'], contrast: [] })
          }
        }
      ]
    })
    const q = await ask({ conversationId: null, text: '找戴眼镜的图', scope: null, includeR18: false })
    const initial = await answer(q.conversation.id)
    expect(initial.images.map((i) => i.name).sort()).toEqual(['眼镜学妹', '眼镜狐娘'])

    // 通过声明式 explain_match 工具解释命中依据
    script.push(
      { tool_calls: [{ id: 'e1', type: 'function', function: { name: 'explain_match', arguments: '{"position":1}' } }] },
      { content: '这张是因为本地识别记录命中了画面特征。' }
    )
    await ask({ conversationId: q.conversation.id, text: '请问这第一张为啥会出现在列表里？', scope: null, includeR18: false })
    const explained = await answer(q.conversation.id)
    expect(explained.text).toContain('画面特征')

    // 通过声明式 exclude_image 工具永久排除第二张
    const secondId = initial.images[1].imageId
    script.push({
      tool_calls: [{ id: 'x1', type: 'function', function: { name: 'exclude_image', arguments: '{"position":2,"permanent":true}' } }]
    })
    await ask({ conversationId: q.conversation.id, text: '第二个结果不好看，后面都别再带它', scope: null, includeR18: false })
    const excluded = await answer(q.conversation.id)
    expect(excluded.images.map((i) => i.imageId)).toEqual([initial.images[0].imageId])
    expect(excluded.text).toContain('记住了')

    // 下一轮新检索自动排除该图
    script.push({
      tool_calls: [
        {
          id: 's3',
          type: 'function',
          function: {
            name: 'search_images',
            arguments: JSON.stringify({ visualInclude: ['glasses'], contrast: [] })
          }
        }
      ]
    })
    const fresh = await ask({ conversationId: null, text: '再找一次戴眼镜的', scope: null, includeR18: false })
    const afterExclude = await answer(fresh.conversation.id)
    expect(afterExclude.images.map((i) => i.imageId)).toEqual([initial.images[0].imageId])
    await getDatabase().pg.query('DELETE FROM ai_memory WHERE content = $1', [`以后检索时排除图片 #${secondId}`])
  })
})
