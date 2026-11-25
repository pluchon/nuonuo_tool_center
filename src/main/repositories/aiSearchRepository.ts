import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { col, likeEscape } from '../db/sqlUtil'
import { aiJob, image, imageEmbedding, imageFile, imageTag, libraryRoot, tag, tagAlias } from '../db/schema'
import type { WdCharacterHint } from '../services/rating/ratingProtocol'
import { hasPendingSuggestion } from './aiResultRepository'

// 诺诺找图的检索条件（服务层已经解析好：词已对到标签 id，对不上的留作关键词）
export interface AiSearchFilter {
  // 复核已有候选时限制到这些图片。
  ids?: number[]
  // 每组是一个条件的候选标签（组内任一），组与组之间都要满足
  tagGroups: number[][]
  // 字面检索时另外标记全部由已确认标签满足的结果，不影响其余候选的准入条件。
  preferredTagGroups?: number[][]
  // 关键词已转小写。每个条件都要匹配，同一条件内的同义词可以互换。
  keywordGroups: string[][]
  orientation?: 'portrait' | 'landscape' | 'square'
  // 只要最近这么多天导入的
  recentDays?: number
  // 只要还没打标签的
  untagged?: boolean
  // 在其中任一目录里（整个源目录，或类目录根下以 prefix 开头的子路径）
  dirs?: Array<{ rootId: number; prefix: string }>
  // 普通检索排除 R-18；R-18 那一路只查 R-18
  r18: 'exclude' | 'only'
  // 语义那一路：按和这个向量的相似度排（只在已经有向量的图里找），低于 minSimilarity 的不要
  vector?: { values: number[]; model: string; minSimilarity: number; contrast?: { values: number[][]; minMargin: number } }
}

// 检索结果：按导入时间从新到旧的图片 id 和总数
export interface AiSearchHit {
  ids: number[]
  total: number
  tagMatchedIds?: number[]
}

// 已确认的标签
const acceptedTag = sql`${col(imageTag.deleteState)} = 0 and ${col(imageTag.status)} = 'ACCEPTED'`

// 检索、历史结果及向量索引共用同一范围。采用的建议只有在整张图复核完毕后才参与检索。
export const confirmedForSearch = sql`not ${hasPendingSuggestion} and exists (
  select 1 from ${imageTag} join ${tag} on ${col(tag.id)} = ${col(imageTag.tagId)}
  where ${col(imageTag.imageId)} = ${col(image.id)} and ${acceptedTag} and ${col(tag.deleteState)} = 0)`

const relativePath = sql`replace(${col(imageFile.relPath)}, chr(92), '/')`

// 未选目录时包含所有类目录。空数组表示原目录已移除或旧版的源目录范围。
export function categoryPosition(dirs?: AiSearchFilter['dirs']): SQL {
  if (dirs?.length === 0) return sql`false`
  const category = sql`${col(libraryRoot.kind)} = 'CATEGORY' and strpos(${relativePath}, '/') > 0`
  if (!dirs) return category
  const positions = dirs.map(({ rootId, prefix }) => {
    const norm = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return norm
      ? sql`(${col(imageFile.rootId)} = ${rootId} and starts_with(lower(${relativePath}), ${norm.toLowerCase() + '/'}))`
      : sql`${col(imageFile.rootId)} = ${rootId}`
  })
  return sql`${category} and (${sql.join(positions, sql` or `)})`
}

function aliveIn(dirs: AiSearchFilter['dirs'], categoryOnly = true): SQL {
  return sql`exists (select 1 from ${imageFile} join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
    where ${col(imageFile.imageId)} = ${col(image.id)} and ${col(imageFile.deleteState)} = 0 and ${col(imageFile.status)} <> 'DELETED'
    and ${col(libraryRoot.deleteState)} = 0 and ${categoryOnly ? categoryPosition(dirs) : sql`true`})`
}

export async function hasSearchableImage(dirs: AiSearchFilter['dirs'], includeR18: boolean): Promise<boolean> {
  const rows = await getDatabase().db.select({ id: image.id }).from(image).where(and(
    eq(image.deleteState, 0), includeR18 ? undefined : eq(image.isR18, false), confirmedForSearch, aliveIn(dirs)
  )).limit(1)
  return rows.length > 0
}

// 检查指定目录范围内是否存在未删除图片（不要求已确认标签），用于区分“空目录”和“图片尚待确认标签/复核”。
export async function hasAnyImageInScope(dirs: AiSearchFilter['dirs'], includeR18: boolean): Promise<boolean> {
  const rows = await getDatabase().db.select({ id: image.id }).from(image).where(and(
    eq(image.deleteState, 0), includeR18 ? undefined : eq(image.isR18, false), aliveIn(dirs)
  )).limit(1)
  return rows.length > 0
}

type CandidateFilter = Omit<AiSearchFilter, 'r18' | 'vector' | 'preferredTagGroups'>

export async function missingSearchVector(model: string, filter: CandidateFilter): Promise<boolean> {
  if (filter.ids?.length === 0 || filter.untagged) return false
  const rows = await getDatabase().db.select({ id: image.id }).from(image).where(and(
    ...candidateConditions(filter, false),
    sql`not exists (select 1 from ${imageEmbedding} where ${col(imageEmbedding.imageId)} = ${col(image.id)}
      and ${col(imageEmbedding.model)} = ${model} and ${col(imageEmbedding.deleteState)} = 0)`
  )).limit(1)
  return rows.length > 0
}

// 当前图片至少有一个已确认的指定标签。
function hasAnyTag(ids: number[]): SQL {
  return sql`exists (select 1 from ${imageTag} join ${tag} on ${col(tag.id)} = ${col(imageTag.tagId)}
    where ${col(imageTag.imageId)} = ${col(image.id)} and ${acceptedTag} and ${col(tag.deleteState)} = 0 and ${inArray(imageTag.tagId, ids)})`
}

// 一个关键词：名字、描述、文件名、标签名、别名里出现就算
function keywordHit(word: string, dirs: AiSearchFilter['dirs']): SQL {
  const p = `%${likeEscape(word)}%`
  return sql`(lower(coalesce(${image.displayName}, '')) like ${p}
    or lower(coalesce(${image.description}, '')) like ${p}
    or exists (select 1 from ${imageFile} join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
      where ${col(imageFile.imageId)} = ${col(image.id)} and ${col(imageFile.deleteState)} = 0 and ${col(imageFile.status)} <> 'DELETED'
      and ${col(libraryRoot.deleteState)} = 0 and ${categoryPosition(dirs)}
      and lower(regexp_replace(replace(${col(imageFile.relPath)}, chr(92), '/'), '^.*/', '')) like ${p})
    or exists (select 1 from ${imageTag} join ${tag} on ${col(tag.id)} = ${col(imageTag.tagId)}
      left join ${tagAlias} on ${col(tagAlias.tagId)} = ${col(tag.id)} and ${col(tagAlias.deleteState)} = 0
      where ${col(imageTag.imageId)} = ${col(image.id)} and ${acceptedTag} and ${col(tag.deleteState)} = 0
      and (lower(${col(tag.name)}) like ${p} or lower(coalesce(${col(tagAlias.name)}, '')) like ${p})))`
}

// 方向：和网格“更多筛选”的判定一致（宽高比 1.05 以上算横，0.95 以下算竖）
function orientationOf(o: NonNullable<AiSearchFilter['orientation']>): SQL {
  const r = sql`(${image.width}::float / nullif(${image.height}, 0))`
  if (o === 'landscape') {
    return sql`${r} > 1.05`
  }
  if (o === 'portrait') {
    return sql`${r} < 0.95`
  }
  return sql`${r} between 0.95 and 1.05`
}

// 按当前可见卡片定位追问的序号。能否读取详情另按本轮目录和最新分级校验。
export async function visibleResultIds(ids: number[], includeR18: boolean, dirs?: AiSearchFilter['dirs']): Promise<Set<number>> {
  if (!ids.length) return new Set()
  const rows = await getDatabase().db.select({ id: image.id }).from(image).where(
    and(sql`${image.id} = any(${sql.param(ids)}::bigint[])`, eq(image.deleteState, 0), includeR18 ? undefined : eq(image.isR18, false), confirmedForSearch, aliveIn(dirs))
  )
  return new Set(rows.map((r) => r.id))
}

// 读取或补充本地识别结果时重新校验图库范围，避免复核或分级变动后继续读取图片。
function visualFeatureScope(imageId: number): SQL | undefined {
  return and(eq(image.id, imageId), eq(image.deleteState, 0), eq(image.isR18, false), confirmedForSearch, aliveIn(undefined))
}

export async function findSearchVisualFeatures(imageId: number) {
  const [row] = await getDatabase().db
    .select({ contentHash: image.contentHash, features: image.visualFeatures })
    .from(image)
    .where(visualFeatureScope(imageId))
    .limit(1)
  return row
}

// 批量按通用标签条件匹配具有当前版本识别记录的普通图。返回编号和是否匹配（ambiguous 命中时为 null）。
export async function matchCachedVisualFeatures(
  ids: number[],
  revision: string,
  includeTags: string[],
  excludeTags: string[] = [],
  ambiguousTags: string[] = []
): Promise<Array<{ id: number; matches: boolean | null }>> {
  if (!ids.length || (!includeTags.length && !excludeTags.length)) return []
  const tags = sql`(${image.visualFeatures}->'tags')`
  const includeOk = includeTags.length ? sql`${tags} ?& ${sql.param(includeTags)}::text[]` : sql`true`
  const excludeOk = excludeTags.length ? sql`not (${tags} ?| ${sql.param(excludeTags)}::text[])` : sql`true`
  const expr = ambiguousTags.length
    ? sql<boolean | null>`case when not (${includeOk} and ${excludeOk}) then false when ${tags} ?| ${sql.param(ambiguousTags)}::text[] then null else true end`
    : sql<boolean | null>`(${includeOk} and ${excludeOk})`
  return getDatabase().db.select({
    id: image.id,
    matches: expr
  }).from(image).where(and(
    sql`${image.id} = any(${sql.param(ids)}::bigint[])`, eq(image.isR18, false),
    sql`${image.visualFeatures}->>'revision' = ${revision} and jsonb_typeof(${tags}) = 'array'`
  ))
}

export async function saveSearchVisualFeatures(
  imageId: number,
  revision: string,
  tags: string[],
  characters?: WdCharacterHint[]
): Promise<boolean> {
  const visualFeatures = { revision, tags, ...(characters !== undefined ? { characters } : {}) }
  const rows = await getDatabase().db.update(image)
    .set({ visualFeatures })
    .where(visualFeatureScope(imageId))
    .returning({ id: image.id })
  return rows.length > 0
}

// 判断缺少向量时也要使用相同的硬性条件，避免无关图片影响本轮检索的完整性。
function candidateConditions(f: CandidateFilter, r18: boolean): Array<SQL | undefined> {
  const conds: Array<SQL | undefined> = [eq(image.deleteState, 0), confirmedForSearch, aliveIn(f.dirs), eq(image.isR18, r18)]
  if (f.ids) conds.push(sql`${image.id} = any(${sql.param(f.ids)}::bigint[])`)
  for (const group of f.tagGroups) {
    conds.push(group.length > 0 ? hasAnyTag(group) : sql`false`)
  }
  for (const group of f.keywordGroups) {
    conds.push(group.length ? sql`(${sql.join(group.map((word) => keywordHit(word, f.dirs)), sql` or `)})` : sql`false`)
  }
  if (f.orientation) {
    conds.push(orientationOf(f.orientation))
  }
  if (f.recentDays !== undefined) {
    conds.push(sql`${image.createTime} >= now() - make_interval(days => ${f.recentDays})`)
  }
  return conds
}

export async function searchImages(f: AiSearchFilter): Promise<AiSearchHit> {
  if (f.ids?.length === 0 || f.untagged || (f.vector && f.r18 === 'only')) return { ids: [], total: 0 }
  const { db } = getDatabase()
  const conds = candidateConditions(f, f.r18 === 'only')
  if (f.vector) {
    const distanceTo = (values: number[]): SQL<number> =>
      sql<number>`(${imageEmbedding.embedding} <=> ${`[${values.join(',')}]`}::vector)`
    const distance = distanceTo(f.vector.values)
    conds.push(sql`${distance} <= ${1 - f.vector.minSimilarity}`)
    // 正反例几乎同分时保留空结果，避免把相近耳形、发色或构图当作明确匹配。
    if (f.vector.contrast) {
      for (const other of f.vector.contrast.values) {
        conds.push(sql`${distance} + ${f.vector.contrast.minMargin}::float8 <= ${distanceTo(other)}`)
      }
    }
    const rows = await db
      .select({ id: image.id })
      .from(image)
      .innerJoin(imageEmbedding, and(eq(imageEmbedding.imageId, image.id), eq(imageEmbedding.model, f.vector.model), eq(imageEmbedding.deleteState, 0)))
      .where(and(...conds))
      .orderBy(distance, desc(image.id))
    return { ids: rows.map((r) => r.id), total: rows.length }
  }
  const preferred = f.preferredTagGroups
  const tagMatch = preferred && preferred.every((group) => group.length > 0)
    ? and(...preferred.map(hasAnyTag)) ?? sql`true`
    : sql`false`
  const rows = await db
    .select({ id: image.id, tagMatch: sql<boolean>`${tagMatch}` })
    .from(image)
    .where(and(...conds))
    .orderBy(desc(image.createTime), desc(image.id))
  return {
    ids: rows.map((r) => r.id),
    total: rows.length,
    ...(preferred ? { tagMatchedIds: rows.filter((row) => row.tagMatch).map((row) => row.id) } : {})
  }
}

// 还没有向量、又过了上云闸门的图（本地模型判过且不是明显 R-18，或你手动关过 R-18），先导入的先做
function pendingEmbedding(model: string) {
  const hasVec = sql`exists (select 1 from ${imageEmbedding} where ${col(imageEmbedding.imageId)} = ${col(image.id)} and ${col(imageEmbedding.model)} = ${model} and ${col(imageEmbedding.deleteState)} = 0)`
  const awaitingLook = sql`exists (select 1 from ${aiJob} where ${col(aiJob.imageId)} = ${col(image.id)}
    and ${col(aiJob.kind)} = 'LOOK' and ${col(aiJob.status)} in ('QUEUED', 'RUNNING') and ${col(aiJob.deleteState)} = 0)`
  return and(
        confirmedForSearch,
        aliveIn(undefined),
        eq(image.deleteState, 0),
        eq(image.isR18, false),
        sql`(${image.ratingSource} = 'MANUAL' or (${image.ratingSource} = 'MODEL' and ${image.rating} in ('GENERAL', 'SENSITIVE')))`,
        sql`not ${hasVec}`,
        // 看图可能将图片转入 R-18 复核，等看图结果落库后再决定是否生成向量。
        sql`not ${awaitingLook}`
  )
}

export function countPendingEmbeddings(model: string): PromiseLike<number> {
  return getDatabase().db.$count(image, pendingEmbedding(model))
}

export async function findEmbedCandidates(model: string, limit: number, imageId?: number): Promise<number[]> {
  const rows = await getDatabase().db.select({ id: image.id }).from(image)
    .where(and(pendingEmbedding(model), imageId === undefined ? undefined : eq(image.id, imageId)))
    .orderBy(image.id)
    .limit(limit)
  return rows.map((r) => r.id)
}

// 上传原文件的哈希由主进程计算。仅复用当前检索范围内普通图片的同模型索引。
export async function findIndexedUpload(hash: string, model: string, dirs: AiSearchFilter['dirs']): Promise<number[] | undefined> {
  const [row] = await getDatabase().db.select({ vector: imageEmbedding.embedding }).from(image)
    .innerJoin(imageEmbedding, and(eq(imageEmbedding.imageId, image.id), eq(imageEmbedding.model, model), eq(imageEmbedding.deleteState, 0)))
    .where(and(eq(image.contentHash, hash), ...candidateConditions({ dirs, tagGroups: [], keywordGroups: [] }, false)))
    .limit(1)
  return row?.vector
}

// 存一张图的向量（同一模型只留一份）
export async function saveEmbedding(imageId: number, model: string, values: number[]): Promise<void> {
  const { db } = getDatabase()
  await db
    .insert(imageEmbedding)
    .values({ imageId, model, embedding: values })
    .onConflictDoUpdate({
      target: [imageEmbedding.imageId, imageEmbedding.model],
      targetWhere: sql`${imageEmbedding.deleteState} = 0`,
      set: { embedding: values, updateTime: new Date() }
    })
}

// 有向量的图有几张
export async function countEmbeddings(model: string): Promise<number> {
  const { db } = getDatabase()
  return db.$count(imageEmbedding, and(eq(imageEmbedding.model, model), eq(imageEmbedding.deleteState, 0)))
}

// 这些图上已确认的标签名（按图分组），给模型看结果用
export async function findTagNamesOf(imageIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  if (imageIds.length === 0) {
    return out
  }
  const { db } = getDatabase()
  const rows = await db
    .select({ imageId: imageTag.imageId, name: tag.name })
    .from(imageTag)
    .innerJoin(tag, eq(tag.id, imageTag.tagId))
    .where(and(inArray(imageTag.imageId, imageIds), eq(imageTag.deleteState, 0), eq(imageTag.status, 'ACCEPTED'), eq(tag.deleteState, 0)))
    .orderBy(imageTag.id)
  for (const r of rows) {
    const list = out.get(r.imageId) ?? []
    list.push(r.name)
    out.set(r.imageId, list)
  }
  return out
}

// 标签词表：每个标签的名字、别名、分类，以及是否用在至少一张非 R-18 图上；传 dirs 时按所选类目录作用域过滤。
export async function findVocabulary(
  searchOnly = false,
  dirs?: AiSearchFilter['dirs'],
  includeR18 = false
): Promise<Array<{ id: number; name: string; categoryId: number; aliases: string[]; general: boolean }>> {
  const { db } = getDatabase()
  const used = (onlyGeneral: boolean) => sql<boolean>`exists (select 1 from ${imageTag} join ${image} on ${col(image.id)} = ${col(imageTag.imageId)}
    where ${col(imageTag.tagId)} = ${col(tag.id)} and ${acceptedTag} and ${col(image.deleteState)} = 0
    and not ${hasPendingSuggestion} and ${aliveIn(dirs, searchOnly)} ${onlyGeneral ? sql`and ${col(image.isR18)} = false` : sql``})`
  const tags = await db.select({ id: tag.id, name: tag.name, categoryId: tag.categoryId, general: used(true) }).from(tag)
    .where(and(eq(tag.deleteState, 0), searchOnly ? used(dirs !== undefined && !includeR18) : undefined)).orderBy(tag.id)
  const aliases = await db
    .select({ tagId: tagAlias.tagId, name: tagAlias.name })
    .from(tagAlias)
    .where(eq(tagAlias.deleteState, 0))
    .orderBy(tagAlias.id)
  const byTag = new Map<number, string[]>()
  for (const a of aliases) {
    byTag.set(a.tagId, [...(byTag.get(a.tagId) ?? []), a.name])
  }
  return tags.map((t) => ({ ...t, aliases: byTag.get(t.id) ?? [] }))
}

// 自然语言中可选择的目录，与聊天输入框的类目录范围一致。
export async function findDirNames(): Promise<Array<{ rootId: number; kind: 'SOURCE' | 'CATEGORY'; name: string }>> {
  const rows = await getDatabase().db
    .selectDistinct({ rootId: imageFile.rootId, name: sql<string>`split_part(${relativePath}, '/', 1)` })
    .from(imageFile).innerJoin(libraryRoot, eq(libraryRoot.id, imageFile.rootId))
    .where(and(categoryPosition(), eq(libraryRoot.deleteState, 0), eq(imageFile.deleteState, 0),
      sql`${imageFile.status} <> 'DELETED' and strpos(${relativePath}, '/') > 0`))
  return rows.map((row) => ({ ...row, kind: 'CATEGORY' }))
}

// 一张图给模型看的信息：名字、文件名、尺寸、是否 R-18
export async function findImageBrief(
  imageId: number,
  search?: { dirs: AiSearchFilter['dirs']; includeR18?: boolean }
): Promise<{ id: number; displayName: string | null; relPath: string | null; width: number | null; height: number | null; isR18: boolean; description: string | null } | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .select({
      id: image.id,
      displayName: image.displayName,
      width: image.width,
      height: image.height,
      isR18: image.isR18,
      description: image.description,
      relPath: sql<string | null>`(select ${col(imageFile.relPath)} from ${imageFile}
        join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
        where ${col(imageFile.imageId)} = ${col(image.id)} and ${col(imageFile.deleteState)} = 0
        and ${col(imageFile.status)} <> 'DELETED' and ${col(libraryRoot.deleteState)} = 0
        and ${search ? categoryPosition(search.dirs) : sql`true`} order by ${col(imageFile.id)} limit 1)`
    })
    .from(image)
    .where(and(eq(image.id, imageId), eq(image.deleteState, 0), search ? and(confirmedForSearch, aliveIn(search.dirs), search.includeR18 ? undefined : eq(image.isR18, false)) : undefined))
    .limit(1)
  return row
}
