import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { findRatingCandidates, saveModelRating, updateR18 } from '../../src/main/repositories/imageRepository'
import { getImageDetail } from '../../src/main/services/galleryService'

// ratingService 引用了 electron 的 utilityProcess；这里只测纯函数，换成空壳
vi.mock('electron', () => ({ utilityProcess: {}, clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))
const { isObviousR18, pickThreads, ratingOf, thresholdFromEnv, THREADS_ACTIVE, THREADS_IDLE } = await import('../../src/main/services/rating/ratingService')

describe('分级线程', () => {
  it('有人在用立刻回到 2 线程；没人用了稳定 1 分钟才加到 4 线程，之后保持', () => {
    expect(pickThreads(false, THREADS_IDLE, 0)).toBe(THREADS_ACTIVE)
    expect(pickThreads(true, THREADS_ACTIVE, 10_000)).toBe(THREADS_ACTIVE)
    expect(pickThreads(true, THREADS_ACTIVE, 61_000)).toBe(THREADS_IDLE)
    expect(pickThreads(true, THREADS_IDLE, 0)).toBe(THREADS_IDLE)
  })
})
const { isModelReady, ensureModel, modelDirOf } = await import('../../src/main/services/rating/modelStore')

describe('分级口径', () => {
  it('取最高分作为分级；questionable + explicit ≥ 0.5 才算明显 R-18', () => {
    expect(ratingOf({ general: 0.7, sensitive: 0.2, questionable: 0.05, explicit: 0.05 })).toBe('GENERAL')
    expect(ratingOf({ general: 0.1, sensitive: 0.2, questionable: 0.3, explicit: 0.4 })).toBe('EXPLICIT')
    expect(isObviousR18({ general: 0.2, sensitive: 0.3, questionable: 0.3, explicit: 0.2 })).toBe(true)
    expect(isObviousR18({ general: 0.3, sensitive: 0.3, questionable: 0.3, explicit: 0.1 })).toBe(false)
    // 只是 sensitive 高的不算
    expect(isObviousR18({ general: 0.1, sensitive: 0.8, questionable: 0.05, explicit: 0.05 })).toBe(false)
  })

  it('测试用阈值只能往下调，往上调和乱填都回到 0.5', () => {
    expect(thresholdFromEnv(undefined)).toBe(0.5)
    expect(thresholdFromEnv('0')).toBe(0)
    expect(thresholdFromEnv('0.2')).toBe(0.2)
    expect(thresholdFromEnv('0.9')).toBe(0.5)
    expect(thresholdFromEnv('abc')).toBe(0.5)
    expect(thresholdFromEnv('-1')).toBe(0.5)
    expect(thresholdFromEnv(' ')).toBe(0.5)
  })
})

describe('模型文件', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-model-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('文件不全或太小不算就绪；齐了直接返回，不联网', async () => {
    expect(await isModelReady(dir)).toBe(false)
    const m = modelDirOf(dir)
    mkdirSync(m, { recursive: true })
    writeFileSync(join(m, 'selected_tags.csv'), 'x'.repeat(200_000))
    writeFileSync(join(m, 'model.onnx'), 'tiny')
    expect(await isModelReady(dir)).toBe(false)
    // 用稀疏的大文件冒充完整模型
    const big = Buffer.alloc(1)
    const fd = await import('node:fs/promises').then((f) => f.open(join(m, 'model.onnx'), 'w'))
    await fd.write(big, 0, 1, 450_000_000)
    await fd.close()
    expect(await isModelReady(dir)).toBe(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await ensureModel(dir)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('分级写库', () => {
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-rating-'))
    const source = join(dir, 'pics')
    mkdirSync(source)
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, thumb_ready) VALUES ('h1', 'JPG', 1, 1), ('h2', 'JPG', 1, 1), ('h3', 'JPG', 1, 2), ('h4', 'JPG', 1, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, 'a.jpg', now()), (2, 1, 'b.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.jpg', now());
    `)
  })
  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('候选只要还没分级、缩略图好了的；手动开关过的不再进候选', async () => {
    expect((await findRatingCandidates(10)).map((r) => r.contentHash)).toEqual(['h1', 'h2', 'h4'])
    await updateR18([4], false)
    expect((await findRatingCandidates(10)).map((r) => r.contentHash)).toEqual(['h1', 'h2'])
  })

  it('模型判的 R-18 打上并标“诺诺判的”；手动关掉后不再是模型判的；手动过的模型写不进去', async () => {
    const scores = { general: 0.1, sensitive: 0.1, questionable: 0.4, explicit: 0.4 }
    expect(await saveModelRating(1, 'EXPLICIT', scores, true)).toBe(true)
    expect(await saveModelRating(2, 'GENERAL', { general: 0.9 }, false)).toBe(true)
    expect(await getImageDetail(1)).toMatchObject({ isR18: true, r18ByModel: true })
    expect(await getImageDetail(2)).toMatchObject({ isR18: false, r18ByModel: false })
    expect(await findRatingCandidates(10)).toEqual([])

    await updateR18([1], false)
    expect(await getImageDetail(1)).toMatchObject({ isR18: false, r18ByModel: false })
    // 已经有来源的图（手动或判过）模型不会再写
    expect(await saveModelRating(1, 'EXPLICIT', scores, true)).toBe(false)
    expect(await saveModelRating(4, 'EXPLICIT', scores, true)).toBe(false)
    expect((await getImageDetail(4)).isR18).toBe(false)
  })
})
