import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReadStream } from 'node:fs'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'

sharp.cache(false)

// 云端换成脚本：记下每次上传的批次里有哪些任务，上传可以卡住不放；实时看图记下看了哪张
const uploaded: string[][] = []
const looked: number[] = []
const realtimePrefixes = new Set<string>()
const batchPrefixes = new Set<string>()
const retrieveBatch = vi.fn(async (id: string): Promise<{ id: string; status: string; output_file_id: string | null; error_file_id?: string }> => ({ id, status: 'in_progress', output_file_id: null }))
const readBatch = vi.fn(async (_id: string) => ({ text: async () => '' }))
const createBatch = vi.fn(async () => ({ id: `batch-${uploaded.length}` }))
const cancelBatch = vi.fn(async (_id: string, _options: unknown) => ({ status: 'cancelling' }))
const listedBatches: Array<{ id: string; input_file_id: string; created_at: number }> = []
let canRun = true
let testImageUrl = ''
const reclassified = new Set([4, 140])
let openGate: () => void = () => undefined
let gate = new Promise<void>((r) => (openGate = r))
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  searchCall: vi.fn(async (meta: { imageId: number; instructions: string }) => {
    looked.push(meta.imageId)
    realtimePrefixes.add(meta.instructions)
    return { text: '```json\n{"name":"测试"}\n```', sources: [], usage: {} }
  }),
  getBailianClient: () => ({
    files: {
      create: async ({ file }: { file: ReadStream }) => {
        const chunks: Buffer[] = []
        for await (const c of file) {
          chunks.push(c as Buffer)
        }
        const ids = Buffer.concat(chunks)
          .toString('utf8')
          .split('\n')
          .map((line) => {
            const request = JSON.parse(line) as { custom_id: string; body: { messages: Array<{ content: string }> } }
            batchPrefixes.add(request.body.messages[0].content)
            return request.custom_id
          })
        await gate
        uploaded.push(ids)
        return { id: `file-${uploaded.length}` }
      },
      content: readBatch
    },
    batches: {
      create: createBatch,
      retrieve: retrieveBatch,
      cancel: cancelBatch,
      list: async function* () { yield* listedBatches }
    }
  }),
  recordBatchUsage: vi.fn(),
  chatCall: vi.fn()
}))
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))
vi.mock('../../src/main/services/ai/imagePrep', () => ({
  prepareImage: async (info: { id: number }) => {
    if (reclassified.has(info.id)) await getDatabase().pg.query('update image set is_r18=true where id=$1', [info.id])
    return testImageUrl
  }
}))

const look = await import('../../src/main/services/ai/lookService')
const { listSuggestions } = await import('../../src/main/services/ai/suggestionService')

const N = 160

describe('一次排进很多图', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-look-batch-'))
    const source = join(dir, 'pics')
    mkdirSync(source)
    const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#BBD5EE' } }).jpeg().toBuffer()
    testImageUrl = `data:image/jpeg;base64,${image.toString('base64')}`
    process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18)
        SELECT 'h' || g, 'JPG', 1, 32, 32, 1, 'GENERAL', 'MODEL', false FROM generate_series(1, ${N}) g;
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT g, 1, 'p' || (g - 1) || '.jpg', now() FROM generate_series(1, ${N}) g;
      INSERT INTO app_setting (key, value) VALUES ('ai.lookSince', '"2000-01-01T00:00:00.000Z"');
      INSERT INTO ai_profile (version, content, tag_vocab) VALUES (1, '使用常见译名', '{"标签":["用于验证的完整词表"]}');
    `)
    look.configureLook({
      thumbsDir: join(dir, 'thumbs'),
      tempDir: join(dir, 'tmp'),
      canRun: () => canRun,
      onState: () => undefined,
      onSuggested: () => undefined,
      moreLater: () => false
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterAll(async () => {
    vi.useRealTimers()
    openGate()
    await look.stopLook()
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  it('连着叫好几次排队，每张图只交一次；批量还在上传时实时看图已经开始', async () => {
    await Promise.all([look.initLook(), look.enqueueNewImages(), look.enqueueNewImages()])
    for (let i = 0; i < 4; i++) {
      look.scheduleLook()
    }
    // 上传卡着没放：实时看图照样在看
    await vi.waitFor(() => expect(looked.length).toBeGreaterThanOrEqual(2), { timeout: 20_000 })
    expect(uploaded).toHaveLength(0)
    openGate()

    // 等到没有排着、也没有没交出去的
    const { pg } = getDatabase()
    await vi.waitFor(
      async () => {
        const left = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_job WHERE status = 'QUEUED' OR (status = 'RUNNING' AND remote_id IS NULL)`)
        expect(left.rows[0].n).toBe(0)
      },
      { timeout: 60_000, interval: 200 }
    )
    const batched = uploaded.flat()
    // 编码期间改为 R-18 的图片须从上传内容中移除，其他图片仍各自完成。
    expect(new Set(batched).size).toBe(batched.length)
    expect(new Set(looked).size).toBe(looked.length)
    const realtimeJobs = (await pg.query<{ id: number }>(`SELECT id FROM ai_job WHERE status = 'DONE'`)).rows.map((r) => String(r.id))
    expect(realtimeJobs.filter((id) => batched.includes(id))).toEqual([])
    const withdrawn = await pg.query<{id:number}>(`select id from ai_job where image_id = any($1::bigint[]) and status='CANCELLED'`, [[...reclassified]])
    expect(withdrawn.rows).toHaveLength(reclassified.size)
    expect(withdrawn.rows.some(row => batched.includes(String(row.id)))).toBe(false)
    expect(looked.some(id => reclassified.has(id))).toBe(false)
    expect(batched.length + looked.length).toBe(N - reclassified.size)
    expect([...realtimePrefixes]).toEqual([expect.stringContaining('用于验证的完整词表')])
    expect([...batchPrefixes]).toEqual([expect.stringContaining('使用常见译名')])
    expect([...batchPrefixes][0]).not.toContain('用于验证的完整词表')
    // 前 50 张左右实时看，超出的走批量
    expect(batched.length).toBeGreaterThanOrEqual(N - 52 - reclassified.size)
    const counts = (await pg.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM ai_job GROUP BY status ORDER BY status::text`)).rows
    expect(counts).toEqual([
      { status: 'CANCELLED', n: reclassified.size },
      { status: 'DONE', n: looked.length },
      { status: 'RUNNING', n: batched.length }
    ])
    const saveNewKey = vi.fn(async () => undefined)
    await expect(look.changeLookBatchKey(saveNewKey)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(saveNewKey).not.toHaveBeenCalled()
    const submittedJob = Number(batched[0])
    await look.retryLook(submittedJob)
    expect((await pg.query('SELECT status FROM ai_job WHERE id = $1', [submittedJob])).rows).toEqual([{ status: 'RUNNING' }])
  }, 120_000)

  it('一个批次查询失败仍处理后面的批次，下一轮继续取回结果', async () => {
    const before = await look.getLookState()
    expect(before.activity).toBe('working')
    expect(before.canCancel).toBe(false)
    expect(before.rows.every((row) => row.state === 'BATCH')).toBe(true)

    const [recoveredId, rejectedId, malformedId] = uploaded[0]
    retrieveBatch.mockImplementationOnce(async () => { throw new Error('暂时无法查询') })
    retrieveBatch.mockResolvedValueOnce({ id: 'batch-2', status: 'completed', output_file_id: null })
    retrieveBatch.mockResolvedValue({ id: 'batch-1', status: 'completed', output_file_id: 'output-1', error_file_id: 'errors-1' })
    readBatch.mockResolvedValueOnce({ text: async () => [
      '无效的结果行',
      JSON.stringify({ custom_id: malformedId, response: { status_code: 200, body: { choices: [{ message: { content: { unexpected: true } } }] } } }),
      JSON.stringify({ custom_id: recoveredId, response: { status_code: 200, body: { choices: [{ message: { content: '```json\n{"name":"批量结果"}\n```' } }] } } })
    ].join('\n') })
    readBatch.mockResolvedValueOnce({ text: async () => JSON.stringify({ custom_id: rejectedId, error: { code: 'DataInspectionFailed', message: 'Input image data may contain inappropriate content.' } }) })

    await vi.advanceTimersByTimeAsync(10_000)
    const { pg } = getDatabase()
    await vi.waitFor(async () => {
      const failures = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_job WHERE status = 'FAILED'`)
      expect(failures.rows[0].n).toBe(uploaded[1].length)
    })
    expect((await look.getLookState()).rows.some((row) => row.error === '正在重试查询')).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(async () => {
      const running = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_job WHERE status = 'RUNNING'`)
      expect(running.rows[0].n).toBe(0)
    })
    const job = await pg.query<{ status: string }>('SELECT status FROM ai_job WHERE id = $1', [recoveredId])
    expect(job.rows[0].status).toBe('DONE')
    expect((await pg.query('SELECT status, error FROM ai_job WHERE id = $1', [malformedId])).rows)
      .toEqual([{ status: 'FAILED', error: '看图结果格式异常' }])
    expect(readBatch).toHaveBeenCalledWith('output-1', expect.objectContaining({ timeout: expect.any(Number) }))
    expect(readBatch).toHaveBeenCalledWith('errors-1', expect.objectContaining({ timeout: expect.any(Number) }))
    const refused = await pg.query<{ id: number; is_r18: boolean; status: string }>('SELECT i.id, i.is_r18, j.status FROM image i JOIN ai_job j ON j.image_id = i.id WHERE j.id = $1', [rejectedId])
    expect(refused.rows[0]).toMatchObject({ is_r18: true, status: 'CANCELLED' })
    expect(await listSuggestions(refused.rows[0].id)).toEqual([expect.objectContaining({ kind: 'r18Review' })])
  })

  it('重启核对已上传但未确认的批次，取回已完成结果并恢复剩余任务', async () => {
    const { pg } = getDatabase()
    const { rows } = await pg.query<{ id: number }>(`
      INSERT INTO ai_job (kind, image_id, status, remote_id, payload, started_at) VALUES
        ('LOOK', 1, 'RUNNING', NULL, '{"lookBatchFileId":"lost-response"}', now()),
        ('LOOK', 2, 'RUNNING', 'paused-batch', '{"resumeOnCancel":true}', now()),
        ('LOOK', 3, 'RUNNING', 'paused-batch', '{"resumeOnCancel":true}', now()) RETURNING id`)
    canRun = false
    const submitted = createBatch.mock.calls.length
    listedBatches.push({ id: 'recovered-batch', input_file_id: 'lost-response', created_at: Math.floor(Date.now() / 1000) })
    retrieveBatch.mockImplementation(async (id) => ({ id, status: id === 'paused-batch' ? 'cancelled' : 'in_progress', output_file_id: id === 'paused-batch' ? 'partial-output' : null }))
    readBatch.mockResolvedValueOnce({ text: async () => JSON.stringify({ custom_id: String(rows[1].id), response: { status_code: 200, body: { choices: [{ message: { content: '```json\n{"name":"已完成"}\n```' } }] } } }) })

    await look.initLook()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(async () => {
      const out = await pg.query<{ status: string; remote_id: string | null; priority: number }>('SELECT status, remote_id, priority FROM ai_job WHERE id = ANY($1::bigint[]) ORDER BY id', [rows.map(({ id }) => id)])
      expect(out.rows).toEqual([
        { status: 'RUNNING', remote_id: 'recovered-batch', priority: 0 },
        { status: 'DONE', remote_id: 'paused-batch', priority: 0 },
        { status: 'QUEUED', remote_id: null, priority: -2 }
      ])
    })
    expect(createBatch).toHaveBeenCalledTimes(submitted)
  })

  it('退出撤销云端批次并停止本地提交，保留恢复所需的任务记录', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18)
        SELECT 'k' || g, 'JPG', 1, 32, 32, 1, 'GENERAL', 'MODEL', false FROM generate_series(1, 120) g;
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT ${N} + g, 1, 'p' || (${N} + g - 1) || '.jpg', now() FROM generate_series(1, 120) g;
    `)
    gate = new Promise<void>((r) => (openGate = r))
    const before = createBatch.mock.calls.length
    canRun = true
    await look.enqueueNewImages()
    const stopping = look.stopLook()
    openGate()
    await stopping
    await delay(1500)
    expect(createBatch).toHaveBeenCalledTimes(before)
    expect(cancelBatch).toHaveBeenCalledWith('recovered-batch', expect.objectContaining({ timeout: expect.any(Number) }))
    const paused = await pg.query<{ payload: unknown }>(`SELECT payload FROM ai_job WHERE remote_id = 'recovered-batch'`)
    expect(paused.rows).toEqual([{ payload: { resumeOnCancel: true } }])
    const queued = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_job WHERE status = 'QUEUED'`)
    expect(queued.rows[0].n).toBeGreaterThan(0)
  }, 60_000)
})
