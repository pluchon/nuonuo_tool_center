import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { open, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { findRatingCandidates, saveModelRating, updateR18 } from '../../src/main/repositories/imageRepository'
import { getImageDetail } from '../../src/main/services/galleryService'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() }, clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))
const { isObviousR18, pickThreads, ratingOf, thresholdFromEnv, THREADS_ACTIVE, THREADS_IDLE } = await import('../../src/main/services/rating/ratingService')

describe('分级线程', () => {
  it('在用软件时立刻回到 3 线程；不用了稳定 1 分钟才加到 4 线程，之后保持', () => {
    expect([THREADS_ACTIVE, THREADS_IDLE]).toEqual([3, 4])
    expect(pickThreads(false, THREADS_IDLE, 0)).toBe(THREADS_ACTIVE)
    expect(pickThreads(true, THREADS_ACTIVE, 10_000)).toBe(THREADS_ACTIVE)
    expect(pickThreads(true, THREADS_ACTIVE, 61_000)).toBe(THREADS_IDLE)
    expect(pickThreads(true, THREADS_IDLE, 0)).toBe(THREADS_IDLE)
  })
})
const { isModelReady, ensureModel, modelDirOf } = await import('../../src/main/services/rating/modelStore')
const { pickModelFile } = await import('../../src/main/services/rating/modelFile')

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

  it.each([200, 206, 416])('修复不完整的正式文件，正确处理续传响应 %i', async (status) => {
    const root = mkdtempSync(join(dir, 'repair-'))
    const m = modelDirOf(root)
    mkdirSync(m)
    const model = await open(join(m, 'model.onnx'), 'w')
    try { await model.truncate(400_000_000) } finally { await model.close() }
    const target = join(m, 'selected_tags.csv')
    writeFileSync(target, '损坏')
    const data = 'a'.repeat(100_000)
    writeFileSync(target + '.part', data.slice(0, 10))
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (status === 416 && !init?.headers) return new Response(data)
      expect(init?.headers).toEqual({ Range: 'bytes=10-' })
      if (status === 416) return new Response(null, { status })
      if (status === 206) return new Response(data.slice(10), { status, headers: { 'content-range': 'bytes 10-99999/100000' } })
      return new Response(data)
    })
    try {
      expect(await ensureModel(root)).toBe(true)
      expect(await readFile(target, 'utf8')).toBe(data)
      expect(request).toHaveBeenCalledTimes(status === 416 ? 2 : 1)
    } finally { request.mockRestore() }
  })

  it('退出时取消未返回的模型下载并保留断点', async () => {
    const root = mkdtempSync(join(dir, 'cancel-'))
    mkdirSync(modelDirOf(root))
    const part = join(modelDirOf(root), 'selected_tags.csv.part')
    writeFileSync(part, '尚未下载完')
    const controller = new AbortController()
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      controller.abort()
    }))
    try {
      expect(await ensureModel(root, controller.signal)).toBe(false)
      expect(request).toHaveBeenCalledTimes(1)
      expect(await readFile(part, 'utf8')).toBe('尚未下载完')
    } finally { request.mockRestore() }
  })

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

  it('有完整的 int8 版就用它，没有或太小用原版', async () => {
    const m = modelDirOf(dir)
    expect(pickModelFile(m)).toBe('model.onnx')
    writeFileSync(join(m, 'model.int8.onnx'), 'tiny')
    expect(pickModelFile(m)).toBe('model.onnx')
    const fd = await import('node:fs/promises').then((f) => f.open(join(m, 'model.int8.onnx'), 'w'))
    await fd.write(Buffer.alloc(1), 0, 1, 170_000_000)
    await fd.close()
    expect(pickModelFile(m)).toBe('model.int8.onnx')
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
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', '类目录', $1)`, [source])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, thumb_ready) VALUES ('h1', 'JPG', 1, 1), ('h2', 'JPG', 1, 1), ('h3', 'JPG', 1, 2), ('h4', 'JPG', 1, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, 'a.jpg', now()), (2, 1, 'pics/b.jpg', now()), (3, 1, 'c.jpg', now()), (4, 1, 'd.jpg', now());
    `)
  })
  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('候选只要还没分级、缩略图好了的，最新导入的在前；指定的图只在里面找；手动开关过的不再进候选', async () => {
    expect((await findRatingCandidates(10)).map((r) => r.contentHash)).toEqual(['h4', 'h2', 'h1'])
    expect((await findRatingCandidates(10, [2, 3])).map((r) => r.contentHash)).toEqual(['h2'])
    expect(await findRatingCandidates(10, [])).toEqual([])
    await updateR18([4], false)
    expect((await findRatingCandidates(10)).map((r) => r.contentHash)).toEqual(['h2', 'h1'])
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

  it('旧图只对并发检索推理一次；持久缓存按版本读取，重新分级后立即排除；为看图提取并缓存角色与视觉特征线索', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO tag (name, category_id) VALUES ('测试特征检索', 4);
      INSERT INTO image_tag (image_id,tag_id,source,status) VALUES (2,1,'MANUAL','ACCEPTED');
      UPDATE image SET visual_features = '{"revision":"旧版","tags":["cat_ears"]}' WHERE id = 2;
      INSERT INTO image (content_hash, format, byte_size, thumb_ready, rating, rating_source, is_r18) VALUES
        ('h5', 'JPG', 1, 1, 'GENERAL', 'MODEL', false),
        ('h6', 'JPG', 1, 1, 'GENERAL', 'MODEL', false),
        ('h7', 'JPG', 1, 1, 'GENERAL', 'MODEL', false);
      UPDATE image SET visual_features = '{"revision":"old","tags":["long_hair"]}' WHERE content_hash = 'h6';
    `)
    const ids = (await pg.query<{ id: number; content_hash: string }>(
      `SELECT id, content_hash FROM image WHERE content_hash IN ('h5', 'h6', 'h7')`
    )).rows
    const idOf = (h: string) => Number(ids.find((r) => r.content_hash === h)!.id)
    const id5 = idOf('h5')
    const id6 = idOf('h6')
    const id7 = idOf('h7')

    const { utilityProcess } = await import('electron')
    const store = await import('../../src/main/services/rating/modelStore')
    const { configureRating, getVisualHintsForLook, getVisualTagsForSearch, stopRating } = await import('../../src/main/services/rating/ratingService')
    const ready = vi.spyOn(store, 'isModelReady').mockResolvedValue(true)
    const worker = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      postMessage: vi.fn(({ id, file }: { id: number; file: string }) => queueMicrotask(() => {
        if (file.includes('h7')) {
          worker.emit('message', {
            id, ok: true,
            scores: { general: 0.1, sensitive: 0.1, questionable: 0.4, explicit: 0.4 },
            tags: ['nsfw_tag'],
            characters: [{ name: 'secret_char', score: 0.9 }]
          })
        } else if (file.includes('h5')) {
          worker.emit('message', {
            id, ok: true,
            scores: { general: 0.9, sensitive: 0.05, questionable: 0.03, explicit: 0.02 },
            tags: ['blue_hair', 'horns'],
            characters: [{ name: 'ganyu', score: 0.912 }]
          })
        } else {
          worker.emit('message', { id, ok: true, scores: {}, tags: ['blue_hair'] })
        }
      }))
    })
    vi.mocked(utilityProcess.fork).mockReturnValue(worker as unknown as ReturnType<typeof utilityProcess.fork>)
    configureRating({ modelsRoot: dir, thumbsDir: dir, workerPath: '', canRun: () => true, onR18: () => {}, threshold: 0.5, onDone: () => {} })
    try {
      expect(await Promise.all([getVisualTagsForSearch(2), getVisualTagsForSearch(2)])).toEqual([['blue_hair'], ['blue_hair']])
      expect(worker.postMessage).toHaveBeenCalledTimes(1)
      ready.mockResolvedValue(false)
      expect(await getVisualTagsForSearch(2)).toEqual(['blue_hair'])
      expect(ready).toHaveBeenCalledTimes(1)
      expect(await getVisualTagsForSearch(3)).toBeNull()
      await updateR18([2], true)
      expect(await getVisualTagsForSearch(2)).toBeNull()

      // 为看图提取并缓存角色与视觉特征线索
      ready.mockResolvedValue(true)
      expect(await getVisualHintsForLook(id5)).toEqual({
        tags: ['blue_hair', 'horns'],
        characters: [{ name: 'ganyu', score: 0.912 }]
      })
      expect(worker.postMessage).toHaveBeenCalledTimes(2)

      // 命中已缓存的 characters，即使模型不可用也直接返回
      ready.mockResolvedValue(false)
      expect(await getVisualHintsForLook(id5)).toEqual({
        tags: ['blue_hair', 'horns'],
        characters: [{ name: 'ganyu', score: 0.912 }]
      })
      // 只有旧版 tags 无 characters 且模型不可用时降级返回已有 tags + 空 characters
      expect(await getVisualHintsForLook(id6)).toEqual({ tags: ['long_hair'], characters: [] })
      expect(worker.postMessage).toHaveBeenCalledTimes(2)

      // 明显 R-18 不持久化也不返回线索
      ready.mockResolvedValue(true)
      expect(await getVisualHintsForLook(id7)).toBeNull()
      const saved7 = (await pg.query<{ visual_features: unknown }>('SELECT visual_features FROM image WHERE id = $1', [id7])).rows[0]
      expect(saved7.visual_features).toBeNull()
    } finally {
      await stopRating()
      ready.mockRestore()
    }
  })
})
