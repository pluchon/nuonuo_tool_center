import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { getDatabase, type AppDatabase } from '../db/client'
import { col } from '../db/sqlUtil'
import { aiJob, image, imageAiResult, imageTag } from '../db/schema'
import { setImmediate as yieldToIpc } from 'node:timers/promises'
import { ratingCandidate } from './imageRepository'
import { writeSettings } from './appSettingRepository'

export type AiResultEntity = typeof imageAiResult.$inferSelect
export type AiJobEntity = typeof aiJob.$inferSelect

export const LOOK_BACKLOG_PRIORITY = -1
export const LOOK_BATCH_PRIORITY = -2
export const LOOK_CONTENT_REJECTED = '云端内容审核未通过'

export function lookBatchFileId(job: AiJobEntity): string | null {
  const payload = job.payload as { lookBatchFileId?: unknown } | null
  return typeof payload?.lookBatchFileId === 'string' ? payload.lookBatchFileId : null
}

export function resumesAfterLookCancel(job: AiJobEntity): boolean {
  return (job.payload as { resumeOnCancel?: boolean } | null)?.resumeOnCancel === true
}

// 建议里一项的状态
export type FieldState = 'PENDING' | 'ACCEPTED' | 'REJECTED'

// 这张图还有没处理的建议
export const hasPendingSuggestion = sql<boolean>`exists (select 1 from ${imageAiResult}
  where ${col(imageAiResult.imageId)} = ${col(image.id)} and ${col(imageAiResult.deleteState)} = 0
  and exists (select 1 from jsonb_each_text(coalesce(${col(imageAiResult.fieldStatus)}, '{}'::jsonb)) as f
              where f.value = 'PENDING' and (not ${col(image.isR18)} or f.key <> 'dir')))`

export const hasPendingR18Review = sql<boolean>`exists (select 1 from ${imageAiResult}
  where ${col(imageAiResult.imageId)} = ${col(image.id)} and ${col(imageAiResult.deleteState)} = 0
  and ${col(imageAiResult.fieldStatus)}->>'r18Review' = 'PENDING')`

// 单张看图被前置审核拦截时，原子结束看图任务并写入 R-18 和待复核建议。
export async function markRejectedImageForReview(jobId: number, model: string): Promise<boolean> {
  return getDatabase().db.transaction(async (tx) => {
    const [job] = await tx.update(aiJob)
      .set({ status: 'CANCELLED', error: LOOK_CONTENT_REJECTED, remoteId: null, payload: null, finishedAt: new Date() })
      .where(and(eq(aiJob.id, jobId), eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'RUNNING')))
      .returning({ imageId: aiJob.imageId })
    if (!job?.imageId) return false

    const [previous] = await tx.select({ id: imageAiResult.id }).from(imageAiResult)
      .where(and(eq(imageAiResult.imageId, job.imageId), eq(imageAiResult.deleteState, 0), sql`${imageAiResult.fieldStatus}->>'r18Review' is not null`))
      .limit(1)
    if (previous) return false

    const [flagged] = await tx.update(image).set({ isR18: true })
      .where(and(eq(image.id, job.imageId), eq(image.isR18, false), eq(image.deleteState, 0)))
      .returning({ id: image.id })
    if (!flagged) return false

    await tx.insert(imageAiResult).values({ imageId: flagged.id, kind: 'IDENTIFY', origin: 'NONO', model, result: {}, fieldStatus: { r18Review: 'PENDING' } })
    return true
  })
}

// 兼容旧版已经转入 AI 建议、仍留在看图失败列表里的图片。
export async function archiveReviewedLookFailures(): Promise<void> {
  await getDatabase().db.update(aiJob).set({ status: 'CANCELLED' }).where(and(
    eq(aiJob.kind, 'LOOK'), eq(aiJob.deleteState, 0), eq(aiJob.status, 'FAILED'), eq(aiJob.error, LOOK_CONTENT_REJECTED),
    sql`exists (select 1 from ${imageAiResult}
      where ${col(imageAiResult.imageId)} = ${col(aiJob.imageId)} and ${col(imageAiResult.deleteState)} = 0
      and ${col(imageAiResult.fieldStatus)}->>'r18Review' is not null)`
  ))
}

// 外部结果与看图队列都只补充空白描述，保留已经确认的内容。
async function fillDescription(tx: Pick<AppDatabase, 'update'>, id: number, description: string): Promise<boolean> {
  if (!description) return false
  const changed = await tx.update(image).set({ description }).where(and(eq(image.id, id), isNull(image.description))).returning({ id: image.id })
  return changed.length > 0
}

export async function saveExternalResult(row: typeof imageAiResult.$inferInsert, description: string): Promise<boolean> {
  return getDatabase().db.transaction(async tx => {
    const filled = await fillDescription(tx, row.imageId, description)
    if (!filled && !Object.keys(row.fieldStatus ?? {}).length) return false
    await tx.insert(imageAiResult).values(row)
    return true
  })
}

// 一张图的全部建议（先来的在前）
export async function findResultsOf(imageId: number): Promise<AiResultEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(imageAiResult)
    .where(and(eq(imageAiResult.imageId, imageId), eq(imageAiResult.deleteState, 0)))
    .orderBy(asc(imageAiResult.id))
}

// 改一条建议里各项的状态
export async function updateFieldStatus(id: number, fieldStatus: Record<string, FieldState>): Promise<void> {
  const { db } = getDatabase()
  await db.update(imageAiResult).set({ fieldStatus }).where(eq(imageAiResult.id, id))
}

// 建议和任务完成状态同时落盘，避免重启后重复处理已收到的结果。
export async function completeLookJob(id: number, row: typeof imageAiResult.$inferInsert, description: string): Promise<boolean> {
  return getDatabase().db.transaction(async (tx) => {
    const changed = await tx.update(aiJob).set({ status: 'DONE', error: null, finishedAt: new Date(), payload: null })
      .where(and(eq(aiJob.id, id), eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'RUNNING'))).returning({ id: aiJob.id })
    if (changed.length === 0) return false
    await tx.insert(imageAiResult).values(row)
    await fillDescription(tx, row.imageId, description)
    return true
  })
}

// 写图片的出处
export async function updateSource(imageId: number, source: string | null): Promise<void> {
  const { db } = getDatabase()
  await db.update(image).set({ source }).where(eq(image.id, imageId))
}

// ===== 看图队列（ai_job 里 kind = LOOK 的行） =====

// 查找符合条件的新图并在同一个事务里入队，防止分级、扫描和整理回调同时排入同一张图。
export async function enqueueNewLookJobs(since: Date, limit: number, priority = 0): Promise<number> {
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: image.id }).from(image).where(lookCandidateWhere(since, false)).orderBy(asc(image.id)).limit(limit)
    await insertLookRows(tx, rows.map(({ id }) => id), priority)
    return rows.length
  })
}

// 能排进看图队列的条件（见上）
function lookCandidateWhere(since: Date, again: boolean): SQL | undefined {
  const accepted = sql`exists (select 1 from ${imageTag} where ${col(imageTag.imageId)} = ${col(image.id)} and ${col(imageTag.deleteState)} = 0 and ${col(imageTag.status)} = 'ACCEPTED')`
  const live = again
    ? sql` and (${col(aiJob.status)} in ('QUEUED', 'RUNNING', 'DONE') or (${col(aiJob.status)} in ('FAILED', 'CANCELLED') and ${col(aiJob.error)} = ${LOOK_CONTENT_REJECTED}))`
    : sql``
  const queued = sql`exists (select 1 from ${aiJob} where ${col(aiJob.imageId)} = ${col(image.id)} and ${col(aiJob.kind)} = 'LOOK'${live})`
  return and(
    eq(image.deleteState, 0),
    eq(image.isR18, false),
    gte(image.createTime, since),
    or(eq(image.ratingSource, 'MANUAL'), and(eq(image.ratingSource, 'MODEL'), inArray(image.rating, ['GENERAL', 'SENSITIVE']))),
    sql`not ${accepted}`,
    sql`not ${queued}`
  )
}

// 能排进看图队列的图有多少张（一键整理开始前的估算）
export async function countLookCandidates(since: Date, again = false): Promise<number> {
  const { db } = getDatabase()
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(image).where(lookCandidateWhere(since, again))
  return Number(row?.n ?? 0)
}

// 按主键分段计数，让窗口在两段查询之间取消估算；每次查询最多检查一批图片。
export async function countOrganizeEstimate(signal?: AbortSignal): Promise<{ toLook: number; ratingLeft: number }> {
  const { db } = getDatabase()
  const batchSize = 256
  const look = lookCandidateWhere(new Date(0), true)
  let cursor = 0
  let toLook = 0
  let ratingLeft = 0
  for (;;) {
    signal?.throwIfAborted()
    const { rows: [row] } = await db.execute<{
      last_id: number; size: number; look: number; rating: number
    }>(sql`select max(id) as last_id, count(*)::int as size,
        count(*) filter (where ${look})::int as look,
        count(*) filter (where ${ratingCandidate})::int as rating
      from (select * from ${image} where id > ${cursor} order by id limit ${batchSize}) as image`)
    toLook += row.look
    ratingLeft += row.rating
    if (row.size < batchSize) return { toLook, ratingLeft }
    cursor = Number(row.last_id)
    await yieldToIpc()
  }
}

// 整理状态、起始时间和看图任务同时落盘。退出后可以恢复同一轮整理。
export async function enqueueOrganizeLooks(settings: Array<{ key: string; value: unknown }>): Promise<number> {
  const { db } = getDatabase()
  return db.transaction(async (tx) => {
    // 旧失败任务保留原完成时间，避免计入新一轮进度。
    await tx.update(aiJob).set({ status: 'CANCELLED', remoteId: null })
      .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'FAILED'), sql`${aiJob.error} IS DISTINCT FROM ${LOOK_CONTENT_REJECTED}`))
    const images = await tx.select({ id: image.id }).from(image).where(lookCandidateWhere(new Date(0), true)).orderBy(asc(image.id))
    await insertLookRows(tx, images.map(({ id }) => id), 0)
    await writeSettings(tx, settings)
    return images.length
  })
}

// 看图队列卡片里每行要的：名字、缩略图哈希（一次查完，不逐张查）
export async function findLookBriefs(imageIds: number[]): Promise<Map<number, { name: string; hash: string }>> {
  if (imageIds.length === 0) {
    return new Map()
  }
  const { pg } = getDatabase()
  const res = await pg.query<{ id: number; content_hash: string; display_name: string | null; rel_path: string | null }>(
    `SELECT i.id, i.content_hash, i.display_name, f.rel_path
       FROM image i
       LEFT JOIN LATERAL (SELECT rel_path FROM image_file WHERE image_id = i.id AND delete_state = 0 AND status = 'NORMAL' ORDER BY id LIMIT 1) f ON true
      WHERE i.id = ANY($1::bigint[]) AND i.delete_state = 0`,
    [imageIds]
  )
  return new Map(res.rows.map((r) => [Number(r.id), { name: r.display_name ?? r.rel_path?.split('\\').pop() ?? '', hash: r.content_hash }]))
}

// ===== 一键整理 =====

// 一张图整理时用的词：已有的标签（按角色、作品、其他分开）加上待确认建议里的角色、作品、标签
export interface OrganizeTerms {
  imageId: number
  characters: string[]
  works: string[]
  tags: string[]
}

// 要整理的图：非 R-18、没删、还不在任何类目录里、也还没有待确认的“放进类目录”建议；带上它们的词
export async function findOrganizeTerms(): Promise<OrganizeTerms[]> {
  const { pg } = getDatabase()
  const res = await pg.query<{ image_id: number; kind: string; name: string }>(
    `WITH todo AS (
       SELECT i.id FROM image i
       WHERE i.delete_state = 0 AND i.is_r18 = false
         AND EXISTS (SELECT 1 FROM image_file f WHERE f.image_id = i.id AND f.delete_state = 0 AND f.status = 'NORMAL')
         AND NOT EXISTS (SELECT 1 FROM image_file f JOIN library_root r ON r.id = f.root_id
                         WHERE f.image_id = i.id AND f.delete_state = 0 AND f.status = 'NORMAL' AND r.delete_state = 0 AND r.kind = 'CATEGORY')
         AND NOT EXISTS (SELECT 1 FROM image_ai_result a WHERE a.image_id = i.id AND a.delete_state = 0 AND a.kind = 'ORGANIZE'
                         AND a.field_status->>'dir' = 'PENDING')
     )
     SELECT it.image_id, CASE c.name WHEN '角色' THEN 'who' WHEN '作品' THEN 'work' ELSE 'tag' END AS kind, t.name
       FROM image_tag it JOIN tag t ON t.id = it.tag_id AND t.delete_state = 0 JOIN tag_category c ON c.id = t.category_id
      WHERE it.image_id IN (SELECT id FROM todo) AND it.delete_state = 0 AND it.status = 'ACCEPTED'
     UNION ALL
     SELECT a.image_id, CASE WHEN f.key = 'who' THEN 'who' WHEN f.key = 'work' THEN 'work' ELSE 'tag' END,
            CASE WHEN f.key = 'who' THEN a.result->>'character' WHEN f.key = 'work' THEN a.result->>'work' ELSE substr(f.key, 5) END
       FROM image_ai_result a, jsonb_each_text(coalesce(a.field_status, '{}'::jsonb)) f
      WHERE a.image_id IN (SELECT id FROM todo) AND a.delete_state = 0 AND a.kind = 'IDENTIFY' AND f.value = 'PENDING'
        AND (f.key IN ('who', 'work') OR f.key LIKE 'tag:%')
     UNION ALL
     SELECT id, 'none', '' FROM todo
     ORDER BY 1`
  )
  const byImage = new Map<number, OrganizeTerms>()
  for (const r of res.rows) {
    const id = Number(r.image_id)
    const t = byImage.get(id) ?? { imageId: id, characters: [], works: [], tags: [] }
    byImage.set(id, t)
    const list = r.kind === 'who' ? t.characters : r.kind === 'work' ? t.works : r.kind === 'tag' ? t.tags : null
    if (list && r.name && !list.includes(r.name)) {
      list.push(r.name)
    }
  }
  return [...byImage.values()]
}

// 存一批“放进类目录”的建议；同一张图建议过同一个目录的（还没处理、采用过、你说过不要的）不再重复建议；返回实际存了几条
export async function insertOrganizeResults(rows: Array<{ imageId: number; dir: string; existing?: boolean }>, model: string): Promise<number> {
  if (rows.length === 0) {
    return 0
  }
  const { db, pg } = getDatabase()
  const seen = await pg.query<{ image_id: number; dir: string }>(
    `SELECT image_id, lower(result->>'dir') AS dir FROM image_ai_result
      WHERE delete_state = 0 AND kind = 'ORGANIZE' AND image_id = ANY($1::bigint[])`,
    [[...new Set(rows.map((r) => r.imageId))]]
  )
  const done = new Set(seen.rows.map((r) => `${Number(r.image_id)}\n${r.dir}`))
  const fresh = rows.filter((r) => !done.has(`${r.imageId}\n${r.dir.toLowerCase()}`))
  for (let i = 0; i < fresh.length; i += 500) {
    await db.insert(imageAiResult).values(
      fresh.slice(i, i + 500).map((r) => ({
        imageId: r.imageId,
        kind: 'ORGANIZE' as const,
        origin: 'NONO' as const,
        model,
        result: { dir: r.dir, ...(r.existing ? { existing: true } : {}) },
        fieldStatus: { dir: 'PENDING' }
      }))
    )
  }
  return fresh.length
}

// “AI 建议”视图里每张图的排序依据（最早一条待确认建议的 id，后来的排在后面）和建议放进的类目录
export async function findPendingSummary(): Promise<Map<number, { firstId: number; dir: string | null; existing: boolean }>> {
  const { pg } = getDatabase()
  const res = await pg.query<{ image_id: number; first_id: number; target: { dir?: string; existing?: boolean } | null }>(
    `SELECT a.image_id, min(a.id) AS first_id,
            (array_agg(a.result order by a.id) filter (where not i.is_r18 and a.kind = 'ORGANIZE' and a.field_status->>'dir' = 'PENDING'))[1] as target
       FROM image_ai_result a JOIN image i ON i.id = a.image_id
      WHERE a.delete_state = 0
        AND EXISTS (SELECT 1 FROM jsonb_each_text(coalesce(a.field_status, '{}'::jsonb)) f
                     WHERE f.value = 'PENDING' AND (NOT i.is_r18 OR f.key <> 'dir'))
      GROUP BY a.image_id`
  )
  return new Map(res.rows.map((r) => [Number(r.image_id), { firstId: Number(r.first_id), dir: r.target?.dir ?? null, existing: r.target?.existing === true }]))
}

// 手动看图：同一张图已有活动任务时复用它。
export async function insertLookJobs(imageIds: number[], priority = 0): Promise<void> {
  if (imageIds.length === 0) {
    return
  }
  const { db } = getDatabase()
  await db.transaction(async (tx) => {
    const active = await tx.select({ imageId: aiJob.imageId }).from(aiJob).where(and(
      eq(aiJob.kind, 'LOOK'), eq(aiJob.deleteState, 0), inArray(aiJob.status, ['QUEUED', 'RUNNING', 'FAILED']), inArray(aiJob.imageId, imageIds)
    ))
    const queued = new Set(active.map(({ imageId }) => imageId))
    await insertLookRows(tx, [...new Set(imageIds)].filter((id) => !queued.has(id)), priority)
  })
}

async function insertLookRows(db: Pick<AppDatabase, 'insert'>, ids: number[], priority: number): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 500) {
    await db.insert(aiJob).values(ids.slice(offset, offset + 500).map((imageId) => ({ kind: 'LOOK' as const, imageId, priority })))
  }
}

// 总数包含整理开始时尚未完成及之后加入的任务；已看数量只统计成功的任务。
export async function countLookProgress(from: Date): Promise<{ done: number; total: number }> {
  const { db } = getDatabase()
  const open = inArray(aiJob.status, ['QUEUED', 'RUNNING'])
  const [row] = await db
    .select({ total: sql<number>`count(*)::int`, done: sql<number>`count(*) filter (where ${eq(aiJob.status, 'DONE')})::int` })
    .from(aiJob)
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.deleteState, 0), or(gte(aiJob.createTime, from), gte(aiJob.finishedAt, from), open)))
  return { done: Number(row?.done ?? 0), total: Number(row?.total ?? 0) }
}

// 队列里还在的（排队、进行中、失败的），优先级高的、先排的在前
export async function findOpenLookJobs(): Promise<AiJobEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(aiJob)
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.deleteState, 0), inArray(aiJob.status, ['QUEUED', 'RUNNING', 'FAILED'])))
    .orderBy(desc(aiJob.priority), asc(aiJob.id))
}

// 改一个任务
export async function updateJob(id: number, patch: Partial<Pick<AiJobEntity, 'status' | 'error' | 'attempts' | 'remoteId' | 'startedAt' | 'finishedAt' | 'priority'>>): Promise<void> {
  const { db } = getDatabase()
  await db.update(aiJob).set(patch).where(eq(aiJob.id, id))
}

// 只重排仍然失败或等待的任务，防止滞后的界面操作重新提交进行中或已完成的请求。
export async function requeueLookJob(id: number, priority?: number): Promise<void> {
  const failed = eq(aiJob.status, 'FAILED')
  await getDatabase().db.update(aiJob)
    .set({ status: 'QUEUED', remoteId: null, payload: null, error: null, startedAt: null, finishedAt: null, priority })
    .where(and(eq(aiJob.id, id), eq(aiJob.kind, 'LOOK'), eq(aiJob.deleteState, 0),
      priority === undefined ? failed : or(failed, and(eq(aiJob.status, 'QUEUED'), isNull(aiJob.remoteId)))))
}

// 在请求创建批次前保存已上传的文件 ID。连接中断时，可用它查询云端是否已经创建批次。
export async function rememberLookBatch(ids: number[], fileId: string): Promise<boolean> {
  return getDatabase().db.transaction(async (tx) => {
    const queued = await tx.select({ id: aiJob.id }).from(aiJob).where(and(inArray(aiJob.id, ids), eq(aiJob.status, 'QUEUED')))
    if (queued.length !== ids.length) return false
    await tx.update(aiJob).set({ status: 'RUNNING', payload: { lookBatchFileId: fileId }, startedAt: new Date() }).where(inArray(aiJob.id, ids))
    return true
  })
}

export async function preferBatchForLookJobs(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  await getDatabase().db.update(aiJob).set({ priority: LOOK_BATCH_PRIORITY })
    .where(and(inArray(aiJob.id, ids), eq(aiJob.priority, 0), eq(aiJob.status, 'QUEUED')))
}

export async function attachLookBatch(ids: number[], remoteId: string): Promise<void> {
  await getDatabase().db.update(aiJob).set({ remoteId, payload: null }).where(inArray(aiJob.id, ids))
}

export async function failLookBatch(ids: number[], error: string): Promise<void> {
  await getDatabase().db.update(aiJob).set({ status: 'FAILED', error, remoteId: null, payload: null, finishedAt: new Date() }).where(inArray(aiJob.id, ids))
}

export async function pauseLookBatch(remoteId: string): Promise<void> {
  await getDatabase().db.update(aiJob).set({ payload: { resumeOnCancel: true } }).where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.remoteId, remoteId), eq(aiJob.status, 'RUNNING')))
}

export async function requeuePausedLookBatch(ids: number[]): Promise<void> {
  await getDatabase().db.update(aiJob).set({
    status: 'QUEUED', error: null, remoteId: null, payload: null, startedAt: null, finishedAt: null,
    priority: sql`CASE WHEN ${aiJob.priority} = 0 THEN ${LOOK_BATCH_PRIORITY} ELSE ${aiJob.priority} END`
  }).where(inArray(aiJob.id, ids))
}

// 取消排队中和失败的（已经发出去的那几张做完为止）
export async function cancelOpenLookJobs(exclude: number[]): Promise<number> {
  const { db } = getDatabase()
  const rows = await db
    .update(aiJob)
    .set({ status: 'CANCELLED', finishedAt: new Date() })
    .where(and(eq(aiJob.kind, 'LOOK'), inArray(aiJob.status, ['QUEUED', 'FAILED']), isNull(aiJob.remoteId), exclude.length ? notInArray(aiJob.id, exclude) : undefined))
    .returning({ id: aiJob.id })
  return rows.length
}

// 取消还没交出去的补图（一键整理停下时）
export async function cancelBacklogJobs(): Promise<number> {
  const { db } = getDatabase()
  const rows = await db
    .update(aiJob)
    .set({ status: 'CANCELLED', finishedAt: new Date() })
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'QUEUED'), isNull(aiJob.remoteId), eq(aiJob.priority, LOOK_BACKLOG_PRIORITY)))
    .returning({ id: aiJob.id })
  return rows.length
}

// 仅将上次中断的实时看图放回队列。已提交和待确认提交结果的批次由轮询恢复。
export async function requeueRunningLookJobs(): Promise<void> {
  const { db } = getDatabase()
  await db
    .update(aiJob)
    .set({ status: 'QUEUED', startedAt: null })
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'RUNNING'), isNull(aiJob.remoteId), sql`(${aiJob.payload}->>'lookBatchFileId') IS NULL`))
}

const cloudAllowed = "NOT i.is_r18 AND (i.rating_source = 'MANUAL' OR (i.rating_source = 'MODEL' AND i.rating IN ('GENERAL', 'SENSITIVE')))"

// 编码和批量打包期间用户仍可修改分级。发送前按当前分级核对整批内容。
export async function allowedLookImages(ids: number[]): Promise<Set<number>> {
  const { rows } = await getDatabase().pg.query<{ id: number }>(
    `SELECT i.id FROM image i WHERE i.id = ANY($1::bigint[]) AND i.delete_state = 0 AND ${cloudAllowed}`, [ids])
  return new Set(rows.map(row => Number(row.id)))
}

// 一张图看图要用的信息：代表文件的位置、名字、元信息、分级状态
export async function findLookInfo(imageId: number, categoryOnly = false): Promise<
  | {
      id: number
      contentHash: string
      displayName: string | null
      exif: unknown
      isR18: boolean
      // 上云闸门放行：本地模型判过且不是明显 R-18，或你手动关过 R-18
      cloudAllowed: boolean
      relPath: string | null
      rootPath: string | null
      width: number | null
      height: number | null
      byteSize: number
    }
  | undefined
> {
  const { pg } = getDatabase()
  const res = await pg.query<{
    id: number
    content_hash: string
    display_name: string | null
    exif: unknown
    is_r18: boolean
    cloud_allowed: boolean
    rel_path: string | null
    root_path: string | null
    width: number | null
    height: number | null
    byte_size: number
  }>(
    `SELECT i.id, i.content_hash, i.display_name, i.exif, i.is_r18, (${cloudAllowed}) AS cloud_allowed, i.width, i.height, i.byte_size, f.rel_path, r.path AS root_path
     FROM image i
     LEFT JOIN LATERAL (SELECT p.rel_path, p.root_id FROM image_file p JOIN library_root loc ON loc.id = p.root_id
       WHERE p.image_id = i.id AND p.delete_state = 0 AND p.status = 'NORMAL' AND loc.delete_state = 0
       AND (NOT $2::boolean OR (loc.kind = 'CATEGORY' AND strpos(replace(p.rel_path, chr(92), '/'), '/') > 0))
       ORDER BY p.id LIMIT 1) f ON true
     LEFT JOIN library_root r ON r.id = f.root_id AND r.delete_state = 0
     WHERE i.id = $1 AND i.delete_state = 0`,
    [imageId, categoryOnly]
  )
  const r = res.rows[0]
  if (!r) {
    return undefined
  }
  return {
    id: Number(r.id),
    contentHash: r.content_hash,
    displayName: r.display_name,
    exif: r.exif,
    isR18: r.is_r18,
    cloudAllowed: r.cloud_allowed === true,
    relPath: r.rel_path,
    rootPath: r.root_path,
    width: r.width,
    height: r.height,
    byteSize: Number(r.byte_size)
  }
}
