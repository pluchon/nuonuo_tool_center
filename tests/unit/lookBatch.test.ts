import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReadStream } from 'node:fs'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'

sharp.cache(false)

// 云端换成脚本：记下每次上传的批次里有哪些任务，上传可以卡住不放；实时看图记下看了哪张
const uploaded: string[][] = []
const looked: number[] = []
let openGate: () => void = () => undefined
let gate = new Promise<void>((r) => (openGate = r))
vi.mock('../../src/main/services/ai/bailianClient', () => ({
  searchCall: vi.fn(async (meta: { imageId: number }) => {
    looked.push(meta.imageId)
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
          .map((l) => (JSON.parse(l) as { custom_id: string }).custom_id)
        await gate
        uploaded.push(ids)
        return { id: `file-${uploaded.length}` }
      }
    },
    batches: {
      create: async () => ({ id: `batch-${uploaded.length}` }),
      retrieve: async (id: string) => ({ id, status: 'in_progress' })
    }
  }),
  recordBatchUsage: vi.fn(),
  chatCall: vi.fn()
}))
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))

const look = await import('../../src/main/services/ai/lookService')

const N = 160

describe('一次排进很多图', () => {
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-look-batch-'))
    const source = join(dir, 'pics')
    mkdirSync(source)
    for (let i = 0; i < N + 120; i++) {
      await sharp({ create: { width: 32, height: 32, channels: 3, background: '#BBD5EE' } }).jpeg().toFile(join(source, `p${i}.jpg`))
    }
    process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18)
        SELECT 'h' || g, 'JPG', 1, 32, 32, 1, 'GENERAL', 'MODEL', false FROM generate_series(1, ${N}) g;
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT g, 1, 'p' || (g - 1) || '.jpg', now() FROM generate_series(1, ${N}) g;
      INSERT INTO app_setting (key, value) VALUES ('ai.lookSince', '"2000-01-01T00:00:00.000Z"');
    `)
    look.configureLook({
      thumbsDir: join(dir, 'thumbs'),
      tempDir: join(dir, 'tmp'),
      canRun: () => true,
      onState: () => undefined,
      onSuggested: () => undefined,
      moreLater: () => false
    })
  })

  afterAll(async () => {
    look.stopLook()
    openGate()
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  it('连着叫好几次排队，每张图只交一次；批量还在上传时实时看图已经开始', async () => {
    await look.initLook()
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
    // 每张只交了一次，交批量的和实时看的不重叠，加起来正好是全部
    expect(new Set(batched).size).toBe(batched.length)
    expect(new Set(looked).size).toBe(looked.length)
    const realtimeJobs = (await pg.query<{ id: number }>(`SELECT id FROM ai_job WHERE status = 'DONE'`)).rows.map((r) => String(r.id))
    expect(realtimeJobs.filter((id) => batched.includes(id))).toEqual([])
    expect(batched.length + looked.length).toBe(N)
    // 前 50 张左右实时看，超出的走批量
    expect(batched.length).toBeGreaterThanOrEqual(N - 52)
    const counts = (await pg.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM ai_job GROUP BY status ORDER BY status::text`)).rows
    expect(counts).toEqual([
      { status: 'DONE', n: looked.length },
      { status: 'RUNNING', n: batched.length }
    ])
  }, 120_000)

  it('退出时正在打包的停下来，不再交新的批次', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, rating, rating_source, is_r18)
        SELECT 'k' || g, 'JPG', 1, 32, 32, 1, 'GENERAL', 'MODEL', false FROM generate_series(1, 120) g;
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) SELECT ${N} + g, 1, 'p' || (${N} + g - 1) || '.jpg', now() FROM generate_series(1, 120) g;
    `)
    gate = new Promise<void>((r) => (openGate = r))
    const before = uploaded.length
    await look.enqueueNewImages()
    look.stopLook()
    openGate()
    await new Promise((r) => setTimeout(r, 1500))
    // 最多交完手上那一批，后面的留在队列里下次启动再交
    expect(uploaded.length - before).toBeLessThanOrEqual(1)
    const queued = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_job WHERE status = 'QUEUED'`)
    expect(queued.rows[0].n).toBeGreaterThan(0)
  }, 60_000)
})
