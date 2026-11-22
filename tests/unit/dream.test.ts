import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'

// 写核心档案的那次模型调用换成脚本
const prompts: string[] = []
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: vi.fn(async (input: { messages: Array<{ content: string }> }) => {
    prompts.push(String(input.messages[0].content))
    return { message: { role: 'assistant', content: '- 表情包放进「表情包」目录\n- 不要用「猫咪」当标签' }, finishReason: 'stop', usage: {} }
  })
}))

const dream = await import('../../src/main/services/ai/dreamService')
const { recordEvent } = await import('../../src/main/services/ai/eventService')

let dir: string
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-dream-'))
  process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  const { pg } = getDatabase()
  await pg.exec(`
    INSERT INTO image (content_hash, format, byte_size, is_r18) VALUES ('h1', 'JPG', 1, false), ('h2', 'JPG', 1, false), ('h3', 'JPG', 1, false), ('h4', 'JPG', 1, true);
    INSERT INTO tag (name, category_id) VALUES ('表情包', 4);
    INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (1, 1, 'MANUAL', 'ACCEPTED'), (2, 1, 'MANUAL', 'ACCEPTED'), (3, 1, 'MANUAL', 'ACCEPTED'), (4, 1, 'MANUAL', 'ACCEPTED');
  `)
})
afterAll(async () => {
  dream.stopDreaming()
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.DASHSCOPE_API_KEY
})

describe('做梦', () => {
  it('规则：同一件事至少 3 次才成偏好；R-18 图的事件不算', async () => {
    for (const id of [1, 2, 3, 4]) {
      await recordEvent('file.move', id, { to: '表情包' })
    }
    for (let i = 0; i < 3; i++) {
      await recordEvent('suggestion.reject', 1, { kind: 'tag', value: '猫咪', origin: 'NONO' })
    }
    await recordEvent('suggestion.reject', 1, { kind: 'tag', value: '只一次', origin: 'NONO' })
    const { pg } = getDatabase()
    expect((await pg.query<{ is_r18: boolean }>(`SELECT is_r18 FROM ai_event WHERE image_id = 4`)).rows[0].is_r18).toBe(true)

    await dream.dreamOnce(true)
    const mem = (await pg.query<{ content: string; confidence: number; kind: string }>(`SELECT content, confidence, kind FROM ai_memory ORDER BY content`)).rows
    expect(mem.map((m) => m.content)).toEqual(['不要用「猫咪」当标签', '带「表情包」标签的图常放进「表情包」目录'])
    // 3 次（第 4 次是 R-18 图，不算）
    expect(mem[1].confidence).toBeCloseTo(0.65)
    expect(mem.every((m) => m.kind === 'rule')).toBe(true)

    // 第一次写核心档案：调一次模型，档案里是模型写的
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('带「表情包」标签的图常放进「表情包」目录（0.65）')
    const prof = (await pg.query<{ version: number; content: string }>(`SELECT version, content FROM ai_profile ORDER BY version`)).rows
    expect(prof).toHaveLength(1)
    expect(prof[0].content).toContain('表情包放进')
  })

  it('重做不会重复写入；一天内不再改档案', async () => {
    await dream.dreamOnce(true)
    const { pg } = getDatabase()
    expect((await pg.query(`SELECT 1 FROM ai_memory`)).rows).toHaveLength(2)
    expect(prompts).toHaveLength(1)
  })

  it('赞给用到的记忆加一点分，踩降分，低到一定程度标失效', async () => {
    const { pg } = getDatabase()
    // ids[0] 是“表情包目录”那条，ids[1] 是“不要用猫咪”那条
    const ids = (await pg.query<{ id: number }>(`SELECT id FROM ai_memory ORDER BY content DESC`)).rows.map((r) => Number(r.id))
    await recordEvent('reply.vote', null, { vote: 'UP', memoryIds: [ids[0]] })
    for (let i = 0; i < 5; i++) {
      await recordEvent('reply.vote', null, { vote: 'DOWN', memoryIds: [ids[1]] })
    }
    await dream.dreamOnce(true)
    const rows = (await pg.query<{ confidence: number; valid_to: Date | null }>(`SELECT confidence, valid_to FROM ai_memory ORDER BY content DESC`)).rows
    expect(rows[0].confidence).toBeCloseTo(0.7)
    expect(rows[0].valid_to).toBeNull()
    expect(rows[1].valid_to).not.toBeNull()
  })

  it('习惯按最近一段时间统计：分几次做的也能攒够次数', async () => {
    const { pg } = getDatabase()
    await pg.exec(`INSERT INTO tag (name, category_id) VALUES ('壁纸', 4); INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (2, 2, 'MANUAL', 'ACCEPTED')`)
    for (let i = 0; i < 3; i++) {
      await recordEvent('file.copy', 2, { to: '桌面壁纸' })
      // 每做一次就做一次梦：单看这一批永远只有 1 次
      await dream.dreamOnce(true)
    }
    const mem = (await pg.query<{ content: string }>(`SELECT content FROM ai_memory WHERE content LIKE '%桌面壁纸%'`)).rows
    // 这张图同时带“表情包”和“壁纸”，两条都成立
    expect(mem.map((m) => m.content)).toContain('带「壁纸」标签的图常放进「桌面壁纸」目录')
  })

  it('不空闲就不做（刚有操作）', async () => {
    dream.markActivity()
    await recordEvent('file.move', 1, { to: '别处' })
    await dream.dreamOnce(false)
    const { pg } = getDatabase()
    const cursor = (await pg.query<{ payload: { lastEventId: number } }>(`SELECT payload FROM ai_job WHERE kind = 'DREAM'`)).rows[0].payload.lastEventId
    const last = (await pg.query<{ id: number }>(`SELECT max(id) AS id FROM ai_event`)).rows[0].id
    expect(cursor).toBeLessThan(Number(last))
  })
})
