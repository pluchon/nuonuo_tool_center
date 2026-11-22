import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { col } from '../db/sqlUtil'
import { aiJob, image, imageAiResult, imageTag } from '../db/schema'

export type AiResultEntity = typeof imageAiResult.$inferSelect
export type AiJobEntity = typeof aiJob.$inferSelect

// 建议里一项的状态
export type FieldState = 'PENDING' | 'ACCEPTED' | 'REJECTED'

// 这张图还有没处理的建议
export const hasPendingSuggestion = sql<boolean>`exists (select 1 from ${imageAiResult}
  where ${col(imageAiResult.imageId)} = ${col(image.id)} and ${col(imageAiResult.deleteState)} = 0
  and exists (select 1 from jsonb_each_text(coalesce(${col(imageAiResult.fieldStatus)}, '{}'::jsonb)) as f where f.value = 'PENDING'))`

// 存一条 AI 建议
export async function insertAiResult(row: typeof imageAiResult.$inferInsert): Promise<AiResultEntity> {
  const { db } = getDatabase()
  const [saved] = await db.insert(imageAiResult).values(row).returning()
  return saved
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

// 写图片的描述（只在还没有描述时写，不覆盖已有的）
export async function fillDescription(imageId: number, description: string): Promise<void> {
  const { db } = getDatabase()
  await db.update(image).set({ description }).where(and(eq(image.id, imageId), isNull(image.description)))
}

// 写图片的出处
export async function updateSource(imageId: number, source: string | null): Promise<void> {
  const { db } = getDatabase()
  await db.update(image).set({ source }).where(eq(image.id, imageId))
}

// ===== 看图队列（ai_job 里 kind = LOOK 的行） =====

// 能自动排进看图队列的图：since 之后导入、没删、不是 R-18、上云闸门放行（本地模型判过且不是明显 R-18，或你手动关过 R-18）、
// 还没打标签、从没排过队（排过又取消的不再自动排）。
// again：一键整理重新开始时用，取消过、出错过的也算（只跳过排着、在看、看完的）
export async function findLookCandidates(since: Date, limit: number, again = false): Promise<number[]> {
  const { db } = getDatabase()
  const rows = await db.select({ id: image.id }).from(image).where(lookCandidateWhere(since, again)).orderBy(asc(image.id)).limit(limit)
  return rows.map((r) => r.id)
}

// 能排进看图队列的条件（见上）
function lookCandidateWhere(since: Date, again: boolean): SQL | undefined {
  const accepted = sql`exists (select 1 from ${imageTag} where ${col(imageTag.imageId)} = ${col(image.id)} and ${col(imageTag.deleteState)} = 0 and ${col(imageTag.status)} = 'ACCEPTED')`
  const live = again ? sql` and ${col(aiJob.status)} in ('QUEUED', 'RUNNING', 'DONE')` : sql``
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

// 出错的看图标成取消（一键整理重新开始时会重新排它们，免得队列里还挂着旧的出错行）
export async function cancelFailedLookJobs(): Promise<number> {
  const { db } = getDatabase()
  const rows = await db
    .update(aiJob)
    .set({ status: 'CANCELLED', remoteId: null, finishedAt: new Date() })
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'FAILED')))
    .returning({ id: aiJob.id })
  return rows.length
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
export async function insertOrganizeResults(rows: Array<{ imageId: number; dir: string }>, model: string): Promise<number> {
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
        result: { dir: r.dir },
        fieldStatus: { dir: 'PENDING' }
      }))
    )
  }
  return fresh.length
}

// “AI 建议”视图里每张图的排序依据（最早一条待确认建议的 id，后来的排在后面）和建议放进的类目录
export async function findPendingSummary(): Promise<Map<number, { firstId: number; dir: string | null }>> {
  const { pg } = getDatabase()
  const res = await pg.query<{ image_id: number; first_id: number; dir: string | null }>(
    `SELECT a.image_id, min(a.id) AS first_id,
            max(CASE WHEN a.kind = 'ORGANIZE' AND a.field_status->>'dir' = 'PENDING' THEN a.result->>'dir' END) AS dir
       FROM image_ai_result a
      WHERE a.delete_state = 0
        AND EXISTS (SELECT 1 FROM jsonb_each_text(coalesce(a.field_status, '{}'::jsonb)) f WHERE f.value = 'PENDING')
      GROUP BY a.image_id`
  )
  return new Map(res.rows.map((r) => [Number(r.image_id), { firstId: Number(r.first_id), dir: r.dir }]))
}

// 排进看图队列
export async function insertLookJobs(imageIds: number[], priority = 0): Promise<void> {
  if (imageIds.length === 0) {
    return
  }
  const { db } = getDatabase()
  await db.insert(aiJob).values(imageIds.map((imageId) => ({ kind: 'LOOK' as const, imageId, priority })))
}

// 一键整理的看图进度：从开始那一刻起排进来的、加上开始时还没看完的，一共几张、做完了几张（出错、取消的也算做完）
export async function countLookProgress(from: Date): Promise<{ done: number; total: number }> {
  const { db } = getDatabase()
  const open = inArray(aiJob.status, ['QUEUED', 'RUNNING'])
  const [row] = await db
    .select({ total: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${open})::int` })
    .from(aiJob)
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.deleteState, 0), or(gte(aiJob.createTime, from), open)))
  const total = Number(row?.total ?? 0)
  return { done: total - Number(row?.open ?? 0), total }
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

// 取消排队中和失败的（已经发出去的那几张做完为止）
export async function cancelOpenLookJobs(): Promise<number> {
  const { db } = getDatabase()
  const rows = await db
    .update(aiJob)
    .set({ status: 'CANCELLED', finishedAt: new Date() })
    .where(and(eq(aiJob.kind, 'LOOK'), inArray(aiJob.status, ['QUEUED', 'FAILED']), isNull(aiJob.remoteId)))
    .returning({ id: aiJob.id })
  return rows.length
}

// 取消还没交出去的补图（一键整理停下时）
export async function cancelBacklogJobs(): Promise<number> {
  const { db } = getDatabase()
  const rows = await db
    .update(aiJob)
    .set({ status: 'CANCELLED', finishedAt: new Date() })
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'QUEUED'), isNull(aiJob.remoteId), sql`${aiJob.priority} < 0`))
    .returning({ id: aiJob.id })
  return rows.length
}

// 应用上次退出时还在进行中的（不是批量提交的）放回排队
export async function requeueRunningLookJobs(): Promise<void> {
  const { db } = getDatabase()
  await db
    .update(aiJob)
    .set({ status: 'QUEUED', startedAt: null })
    .where(and(eq(aiJob.kind, 'LOOK'), eq(aiJob.status, 'RUNNING'), isNull(aiJob.remoteId)))
}

// 一张图看图要用的信息：代表文件的位置、名字、元信息、分级状态
export async function findLookInfo(imageId: number): Promise<
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
    `SELECT i.id, i.content_hash, i.display_name, i.exif, i.is_r18, (NOT i.is_r18 AND (i.rating_source = 'MANUAL' OR (i.rating_source = 'MODEL' AND i.rating IN ('GENERAL', 'SENSITIVE')))) AS cloud_allowed, i.width, i.height, i.byte_size, f.rel_path, r.path AS root_path
     FROM image i
     LEFT JOIN LATERAL (SELECT rel_path, root_id FROM image_file WHERE image_id = i.id AND delete_state = 0 AND status = 'NORMAL' ORDER BY id LIMIT 1) f ON true
     LEFT JOIN library_root r ON r.id = f.root_id AND r.delete_state = 0
     WHERE i.id = $1 AND i.delete_state = 0`,
    [imageId]
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
