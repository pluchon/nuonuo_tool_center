import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { hashBuffer } from '../../src/main/services/scan/imageProbe'

const chatCallMock = vi.fn()
const searchCallMock = vi.fn()
const scheduleLookMock = vi.fn()
const pushLookStateMock = vi.fn(async () => undefined)

vi.mock('../../src/main/services/ai/bailianClient', () => ({
  chatCall: chatCallMock,
  searchCall: searchCallMock,
  getBailianClient: vi.fn(),
  recordBatchUsage: vi.fn()
}))

vi.mock('../../src/main/services/ai/lookService', () => ({
  scheduleLook: scheduleLookMock,
  pushLookState: pushLookStateMock
}))

vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))

const reorg = await import('../../src/main/services/ai/reorganizeService')
const org = await import('../../src/main/services/ai/organizeService')
const scan = await import('../../src/main/services/scan/scanService')
const { configureFolderOps } = await import('../../src/main/services/fileOps/folderOpsService')
const { configureTransfer } = await import('../../src/main/services/fileOps/transferService')
const { configureFileOps } = await import('../../src/main/services/fileOps/fileOpsService')
const { LOOK_CONTENT_REJECTED } = await import('../../src/main/repositories/aiResultRepository')

describe('重新整理（估算、归回源目录、参考上下文重看）', () => {
  let dir: string
  let sourceDir: string
  let libraryDir: string
  let trashedPaths: string[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-reorganize-'))
    sourceDir = join(dir, 'source')
    libraryDir = join(dir, 'library')
    trashedPaths = []
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(join(libraryDir, '角色'), { recursive: true })
    mkdirSync(join(libraryDir, '重复'), { recursive: true })
    mkdirSync(join(libraryDir, 'R18'), { recursive: true })

    process.env.DASHSCOPE_API_KEY = 'test-key-not-real'
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    configureFolderOps(libraryDir)
    configureTransfer(libraryDir)
    configureFileOps({
      trash: async (p) => {
        const dest = join(dir, `bin-${trashedPaths.length}-${Date.now()}`)
        renameSync(p, dest)
        trashedPaths.push(p)
      },
      onDone: () => undefined
    })

    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'source', $1), ('CATEGORY', 'library', $2)`, [
      sourceDir,
      libraryDir
    ])
  })

  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DASHSCOPE_API_KEY
  })

  it('估算统计已整理非 R-18 图片、待重看张数及未分级张数，并支持中止信号', async () => {
    const { pg, db } = getDatabase()
    const bufA = Buffer.from('img-a')
    const bufB = Buffer.from('img-b')
    const bufC = Buffer.from('img-c')
    const bufD = Buffer.from('img-d')
    const bufE = Buffer.from('img-e')
    const bufF = Buffer.from('img-f')

    writeFileSync(join(sourceDir, 'a.jpg'), bufA)
    writeFileSync(join(libraryDir, '角色', 'a.jpg'), bufA)
    writeFileSync(join(sourceDir, 'b.jpg'), bufB)
    writeFileSync(join(sourceDir, 'c.jpg'), bufC)
    writeFileSync(join(sourceDir, 'd.jpg'), bufD)
    writeFileSync(join(libraryDir, 'R18', 'e.jpg'), bufE)
    writeFileSync(join(sourceDir, 'f.jpg'), bufF)

    await pg.exec(`
      INSERT INTO tag (name, category_id) SELECT '测试标签', id FROM tag_category WHERE name = '主题';
      INSERT INTO image (content_hash, format, byte_size, display_name, description, source, rating, rating_source, is_r18, thumb_ready) VALUES
        ('${hashBuffer(bufA)}', 'JPG', ${bufA.length}, '名字A', '描述A', 'https://example.com/a', 'GENERAL', 'MODEL', false, 1),
        ('${hashBuffer(bufB)}', 'JPG', ${bufB.length}, NULL, NULL, NULL, 'SENSITIVE', 'MANUAL', false, 1),
        ('${hashBuffer(bufC)}', 'JPG', ${bufC.length}, '待重看C', NULL, NULL, 'GENERAL', 'MODEL', false, 1),
        ('${hashBuffer(bufD)}', 'JPG', ${bufD.length}, '仅名字D', NULL, NULL, 'GENERAL', 'MODEL', false, 1),
        ('${hashBuffer(bufE)}', 'JPG', ${bufE.length}, 'R18图', NULL, NULL, 'EXPLICIT', 'MODEL', true, 1),
        ('${hashBuffer(bufF)}', 'JPG', ${bufF.length}, '未分级F', NULL, NULL, 'UNKNOWN', NULL, false, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES
        (1, 1, 'a.jpg', now()), (1, 2, '角色\\a.jpg', now()),
        (2, 1, 'b.jpg', now()),
        (3, 1, 'c.jpg', now()),
        (4, 1, 'd.jpg', now()),
        (5, 2, 'R18\\e.jpg', now()),
        (6, 1, 'f.jpg', now());
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES
        (2, 1, 'MANUAL', 'ACCEPTED'),
        (3, 1, 'MANUAL', 'ACCEPTED'),
        (5, 1, 'MANUAL', 'ACCEPTED'),
        (6, 1, 'MANUAL', 'ACCEPTED');
      INSERT INTO ai_job (kind, image_id, status) VALUES ('LOOK', 1, 'DONE'), ('LOOK', 3, 'QUEUED');
    `)

    // 已整理且非 R-18：1(在类目录), 2(有ACCEPTED标签), 3(有ACCEPTED标签), 6(有ACCEPTED标签，未分级) => 4 张
    // 4 仅有 display_name 无已采用标签/类目录，不计入；5 是 R-18 不计入
    // toLook：1(DONE,可重看), 2(无job,可重看) => 2 张；3 有 QUEUED 不重复算；6 未分级不进 toLook 进 ratingLeft(1)
    const est = await reorg.estimateReorganize()
    expect(est.organizedCount).toBe(4)
    expect(est.toLook).toBe(2)
    expect(est.ratingLeft).toBe(1)
    expect(est.tokens).toBe(3 * 2600)
    expect(est.yuan).toBeGreaterThan(0)

    // 中止信号提前停止分批查询
    const controller = new AbortController()
    await pg.exec(
      "insert into image (content_hash, format, byte_size) select 'cancel-reorg-' || i, 'JPG', 1 from generate_series(1, 300) i"
    )
    const executeSpy = vi.spyOn(db, 'execute')
    try {
      const p = reorg.estimateReorganize(controller.signal)
      setImmediate(() => controller.abort())
      await expect(p).rejects.toMatchObject({ name: 'AbortError' })
      expect(executeSpy).toHaveBeenCalledTimes(1)
    } finally {
      executeSpy.mockRestore()
      await pg.exec("delete from image where content_hash like 'cancel-reorg-%'")
    }
  })

  it('模式1 归回源目录：有源目录副本时只删类目录副本；仅在类目录时安全移回源目录；保留分级与 R-18，不调用大模型', async () => {
    const { pg } = getDatabase()
    // 清理上一条的测试图像 F 的未分级状态以免干扰，并新增一条“仅在类目录且存在两份类目录副本”的图片 G，以及“源目录同名冲突”验证
    const bufG = Buffer.from('img-g-only-category')
    const bufCollision = Buffer.from('existing-in-source')
    writeFileSync(join(libraryDir, '角色', 'only-cat.jpg'), bufG)
    writeFileSync(join(libraryDir, '重复', 'only-cat.jpg'), bufG)
    // 在源目录放一个同名文件测试防覆盖
    writeFileSync(join(sourceDir, 'only-cat.jpg'), bufCollision)

    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name, description, source, rating, rating_source, rating_scores, visual_features, is_r18, thumb_ready)
      VALUES ('${hashBuffer(bufG)}', 'JPG', ${bufG.length}, '仅类目录G', '描述G', 'https://example.com/g', 'GENERAL', 'MODEL', '{"general":0.95}', '{"revision":"v1","tags":["1girl"]}', false, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
      SELECT id, 2, '角色\\only-cat.jpg', now() FROM image WHERE content_hash = '${hashBuffer(bufG)}';
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
      SELECT id, 2, '重复\\only-cat.jpg', now() FROM image WHERE content_hash = '${hashBuffer(bufG)}';
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
      VALUES (1, 'ORGANIZE', 'm', '{"dir":"角色"}', '{"dir":"ACCEPTED"}');
      INSERT INTO ai_job (kind, image_id, status) VALUES ('LOOK', 2, 'FAILED');
    `)

    // 扫描或一键整理进行中拒绝执行
    const scanSpy = vi.spyOn(scan, 'getScanState').mockReturnValue({
      progress: { rootName: null, rootIds: [1], done: 0, total: 1, found: 0 },
      last: null
    })
    await expect(reorg.resetOrganizedToSource()).rejects.toMatchObject({ code: 'CONFLICT' })
    scanSpy.mockRestore()

    const orgSpy = vi.spyOn(org, 'isOrganizing').mockReturnValue(true)
    await expect(reorg.resetOrganizedToSource()).rejects.toMatchObject({ code: 'CONFLICT' })
    orgSpy.mockRestore()

    chatCallMock.mockClear()
    searchCallMock.mockClear()
    trashedPaths.length = 0

    const res = await reorg.resetOrganizedToSource()
    expect(chatCallMock).not.toHaveBeenCalled()
    expect(searchCallMock).not.toHaveBeenCalled()

    // 1, 2, 3, 6, G 共 5 张已整理非 R-18 图
    expect(res).toEqual({
      resetImages: 5,
      removedCopies: 2, // A 的类目录副本 + G 的第二份类目录副本
      movedToSource: 1, // G 的主副本从类目录移回源目录
      skippedOnlyInCategory: 0
    })

    // A：源目录文件完好，类目录副本被移入回收站
    expect(existsSync(join(sourceDir, 'a.jpg'))).toBe(true)
    expect(existsSync(join(libraryDir, '角色', 'a.jpg'))).toBe(false)

    // G：唯一文件没有被删，因源目录已有同名文件，自动重命名为 only-cat (2).jpg 移回源目录，第二份类目录副本进入回收站
    expect(existsSync(join(libraryDir, '角色', 'only-cat.jpg'))).toBe(false)
    expect(existsSync(join(libraryDir, '重复', 'only-cat.jpg'))).toBe(false)
    expect(readFileSync(join(sourceDir, 'only-cat.jpg'))).toEqual(bufCollision)
    expect(readFileSync(join(sourceDir, 'only-cat (2).jpg'))).toEqual(bufG)

    // R-18 图 E 完全保留（文件、标签、名字、is_r18）
    expect(existsSync(join(libraryDir, 'R18', 'e.jpg'))).toBe(true)
    const eRow = (await pg.query<{ display_name: string; is_r18: boolean }>(`SELECT display_name, is_r18 FROM image WHERE id = 5`)).rows[0]
    expect(eRow).toEqual({ display_name: 'R18图', is_r18: true })
    const eTags = (await pg.query(`SELECT 1 FROM image_tag WHERE image_id = 5 AND delete_state = 0`)).rows
    expect(eTags).toHaveLength(1)

    // A 与 G 的元数据被清空，但 rating / rating_source / rating_scores / visual_features 完整保留
    const gRow = (
      await pg.query<{
        display_name: string | null
        description: string | null
        source: string | null
        rating: string
        rating_source: string
        rating_scores: unknown
        visual_features: unknown
      }>(
        `SELECT display_name, description, source, rating::text, rating_source::text, rating_scores, visual_features
           FROM image WHERE content_hash = '${hashBuffer(bufG)}'`
      )
    ).rows[0]
    expect(gRow).toEqual({
      display_name: null,
      description: null,
      source: null,
      rating: 'GENERAL',
      rating_source: 'MODEL',
      rating_scores: { general: 0.95 },
      visual_features: { revision: 'v1', tags: ['1girl'] }
    })

    // 原先已整理的图片的 tag、ai_result 被逻辑删除，失败/排队看图任务被取消
    expect((await pg.query(`SELECT 1 FROM image_tag WHERE image_id = 2 AND delete_state = 0`)).rows).toHaveLength(0)
    expect((await pg.query(`SELECT 1 FROM image_ai_result WHERE image_id = 1 AND delete_state = 0`)).rows).toHaveLength(0)
    const job2 = (await pg.query<{ status: string }>(`SELECT status::text FROM ai_job WHERE image_id = 2 AND kind = 'LOOK'`)).rows[0]
    expect(job2.status).toBe('CANCELLED')
    const job3 = (await pg.query<{ status: string }>(`SELECT status::text FROM ai_job WHERE image_id = 3 AND kind = 'LOOK'`)).rows[0]
    expect(job3.status).toBe('CANCELLED')

    // 归回源目录后再估算，非 R-18 已整理图片应归零
    const afterResetEst = await reorg.estimateReorganize()
    expect(afterResetEst.organizedCount).toBe(0)
  })

  it('模式1 在源目录均离线时不删除仅存于类目录的唯一图片', async () => {
    const { pg } = getDatabase()
    const bufH = Buffer.from('img-h-offline-source')
    writeFileSync(join(libraryDir, '角色', 'offline-h.jpg'), bufH)
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name, rating, rating_source, is_r18, thumb_ready)
      VALUES ('${hashBuffer(bufH)}', 'JPG', ${bufH.length}, '离线保留H', 'GENERAL', 'MODEL', false, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
      SELECT id, 2, '角色\\offline-h.jpg', now() FROM image WHERE content_hash = '${hashBuffer(bufH)}';
    `)

    // 暂时把源目录改成不存在的路径模拟离线
    await pg.query(`UPDATE library_root SET path = $1 WHERE id = 1`, [join(dir, 'missing-source-drive')])
    try {
      const res = await reorg.resetOrganizedToSource()
      expect(res).toEqual({
        resetImages: 0,
        removedCopies: 0,
        movedToSource: 0,
        skippedOnlyInCategory: 1
      })
      expect(existsSync(join(libraryDir, '角色', 'offline-h.jpg'))).toBe(true)
      const hRow = (
        await pg.query<{ display_name: string }>(`SELECT display_name FROM image WHERE content_hash = '${hashBuffer(bufH)}'`)
      ).rows[0]
      expect(hRow.display_name).toBe('离线保留H')
    } finally {
      await pg.query(`UPDATE library_root SET path = $1 WHERE id = 1`, [sourceDir])
    }
  })

  it('模式2 重新 AI 整理：校验密钥与分级闸门，按 payload { reorganize: true } 入队且排除 R-18', async () => {
    const { pg } = getDatabase()
    scheduleLookMock.mockClear()

    // 把 1、2、6 标为已整理（有 ACCEPTED 标签），4 仍仅名字未入库，5 仍是 R-18，6 设为未分级
    await pg.exec(`
      UPDATE image SET display_name = '已整理1' WHERE id = 1;
      INSERT INTO image_tag (image_id, tag_id, source, status) VALUES
        (1, 1, 'MANUAL', 'ACCEPTED'),
        (2, 1, 'MANUAL', 'ACCEPTED'),
        (6, 1, 'MANUAL', 'ACCEPTED');
      UPDATE image SET display_name = '未分级6', rating_source = NULL, rating = 'UNKNOWN', thumb_ready = 1 WHERE id = 6;
      INSERT INTO ai_job (kind, image_id, status, error) VALUES
        ('LOOK', 1, 'FAILED', '网络异常'),
        ('LOOK', 2, 'FAILED', '${LOOK_CONTENT_REJECTED}');
    `)

    // 缺少 API Key 报错
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    try {
      await expect(reorg.startReorganizeRelook()).rejects.toMatchObject({ code: 'DEPENDENCY_FAILED' })
    } finally {
      vi.unstubAllEnvs()
    }

    // 存在未分级已整理图片（图片 6）时拒绝执行
    await expect(reorg.startReorganizeRelook()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '本地分级还剩 1 张，判完才能重新整理'
    })

    // 取消 6 的已整理标签，使待分级为 0
    await pg.exec(`UPDATE image_tag SET delete_state = 1 WHERE image_id = 6`)

    const hId = Number((await pg.query<{ id: number }>(`SELECT id FROM image WHERE display_name = '离线保留H'`)).rows[0].id)
    const res = await reorg.startReorganizeRelook()
    // 应入队：1, 2, hId 共 3 张（4 未整理，5 是 R-18）
    expect(res).toEqual({ enqueued: 3 })
    expect(scheduleLookMock).toHaveBeenCalledTimes(1)

    const queuedRows = (
      await pg.query<{ image_id: number; payload: unknown }>(
        `SELECT image_id, payload FROM ai_job WHERE kind = 'LOOK' AND status = 'QUEUED' ORDER BY image_id`
      )
    ).rows
    expect(queuedRows.map((r) => Number(r.image_id))).toEqual([1, 2, hId])
    expect(queuedRows.every((r) => (r.payload as { reorganize?: boolean })?.reorganize === true)).toBe(true)

    // 先前普通失败任务被取消，审核失败任务保留
    const failed1 = (
      await pg.query<{ status: string }>(`SELECT status::text FROM ai_job WHERE kind = 'LOOK' AND image_id = 1 AND error = '网络异常'`)
    ).rows[0]
    expect(failed1.status).toBe('CANCELLED')
    const rejected2 = (
      await pg.query<{ status: string }>(
        `SELECT status::text FROM ai_job WHERE kind = 'LOOK' AND image_id = 2 AND error = '${LOOK_CONTENT_REJECTED}'`
      )
    ).rows[0]
    expect(rejected2.status).toBe('FAILED')
  })

  it('严格排除带待确认 AI 建议的图片，并与一键整理及扫描写盘阶段互斥', async () => {
    const { pg } = getDatabase()
    // 清理上一轮的排队任务，先验证互斥再验证严格范围
    expect(await reorg.isReorganizeBusy()).toBe(true)
    await expect(org.startOrganize()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '正在重新整理，请先等待完成或停止当前队列'
    })
    await expect(reorg.startReorganizeRelook()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(reorg.resetOrganizedToSource()).rejects.toMatchObject({ code: 'CONFLICT' })

    // 扫描协同：重新整理看图队列中允许手动扫描；仅 ASSIGNING / resetting 才阻塞 startScan
    scan.configureScan({ thumbsDir: join(dir, 'thumbs'), categoryHomeOverride: libraryDir, canRunAuto: () => true })
    expect(() => scan.startScan(null)).not.toThrow()
    await scan.stopScanAndWait()

    const assignSpy = vi.spyOn(org, 'getOrganizeState').mockReturnValue({ phase: 'ASSIGNING', plan: null, error: null })
    expect(() => scan.startScan(null)).toThrow('正在整理文件，请稍候再扫描')
    assignSpy.mockRestore()

    const planReadySpy = vi.spyOn(org, 'getOrganizeState').mockReturnValue({ phase: 'PLAN_READY', plan: [], error: null })
    expect(() => scan.startScan(null)).not.toThrow()
    await scan.stopScanAndWait()
    await expect(reorg.startReorganizeRelook()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(reorg.resetOrganizedToSource()).rejects.toMatchObject({ code: 'CONFLICT' })
    planReadySpy.mockRestore()

    // 结束排队中的重新整理任务
    await pg.exec(`UPDATE ai_job SET status = 'DONE' WHERE kind = 'LOOK' AND status IN ('QUEUED', 'RUNNING')`)
    expect(await reorg.isReorganizeBusy()).toBe(false)

    // 给图 1 加上 PENDING AI 建议（保留图 1 的 ACCEPTED 标签），给图 4 仅保留 display_name（无 tag / 类目录）
    await pg.exec(`
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
      VALUES (1, 'IDENTIFY', 'm', '{"name":"待审名字"}', '{"name":"PENDING"}')
    `)
    const estPending = await reorg.estimateReorganize()
    // 1 有 PENDING 建议被排除，4 仅 display_name 被排除；仅剩 2(ACCEPTED标签) 和 H(类目录) => 2 张
    expect(estPending.organizedCount).toBe(2)
    expect(estPending.pendingSuggestionCount).toBe(1)

    // 把存在待确认 ORGANIZE dir 建议的新图手动移入类目录后，应自动清除该 dir 待确认状态并纳入已整理计数
    const { pg: pgDb } = getDatabase()
    const bufMove = Buffer.from('img-manual-move-cat')
    writeFileSync(join(sourceDir, 'manual-move.jpg'), bufMove)
    const { hashBuffer: hashBuf } = await import('../../src/main/services/scan/imageProbe')
    const hMove = hashBuf(bufMove)
    await pgDb.exec(`
      INSERT INTO image (content_hash, format, byte_size, rating, rating_source, is_r18, thumb_ready)
      VALUES ('${hMove}', 'JPG', ${bufMove.length}, 'GENERAL', 'MODEL', false, 1);
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
      SELECT id, 1, 'manual-move.jpg', now() FROM image WHERE content_hash = '${hMove}';
      INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
      SELECT id, 'ORGANIZE', 'm', '{"dir":"角色"}', '{"dir":"PENDING"}' FROM image WHERE content_hash = '${hMove}';
    `)
    const { moveImages } = await import('../../src/main/services/fileOps/transferService')
    await moveImages({ view: 'all', sort: 'new' }, [Number((await pgDb.query<{ id: number }>(`SELECT id FROM image WHERE content_hash = '${hMove}'`)).rows[0].id)], join(libraryDir, '角色'))
    const estAfterManualMove = await reorg.estimateReorganize()
    expect(estAfterManualMove.organizedCount).toBe(3)

    // 验证归回源目录也严格排除带 PENDING 建议的图 1
    const resetRes = await reorg.resetOrganizedToSource()
    expect(resetRes.resetImages).toBe(3)
    expect((await pg.query(`SELECT 1 FROM image_tag WHERE image_id = 1 AND delete_state = 0`)).rows).toHaveLength(1)

    // 单图容错：即使图片还挂着陈旧 PENDING AI 建议，也能直接回归源目录清干净
    const singleReset = await reorg.resetSingleImageToSource(1)
    expect(singleReset.resetImages).toBe(1)
    expect((await pg.query(`SELECT 1 FROM image_ai_result WHERE image_id = 1 AND delete_state = 0`)).rows).toHaveLength(0)
    expect((await pg.query(`SELECT 1 FROM image_tag WHERE image_id = 1 AND delete_state = 0`)).rows).toHaveLength(0)

    // 单图诺诺重新看：入队 payload { reorganize: true }，已在队列时拒绝重复入队
    const relookOne = await reorg.relookSingleImage(2)
    expect(relookOne.enqueued).toBe(1)
    await expect(reorg.relookSingleImage(2)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
