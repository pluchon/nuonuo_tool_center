import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { col, likeEscape } from '../db/sqlUtil'
import { image, imageEmbedding, imageFile, imageTag, libraryRoot, tag, tagAlias } from '../db/schema'

// 诺诺找图的检索条件（服务层已经解析好：词已对到标签 id，对不上的留作关键词）
export interface AiSearchFilter {
  // 每组是一个条件的候选标签（组内任一），组与组之间都要满足
  tagGroups: number[][]
  // 关键词（已转小写）：任一个在名字、文件名、描述、标签名或别名里出现就算（模型常把同义词一起给）
  keywords: string[]
  orientation?: 'portrait' | 'landscape' | 'square'
  // 只要最近这么多天导入的
  recentDays?: number
  // 只要还没打标签的
  untagged?: boolean
  // 在其中任一目录里（整个源目录，或类目录根下以 prefix 开头的子路径）
  dirs?: Array<{ rootId: number; prefix: string }>
  // 普通检索排除 R-18；R-18 那一路只查 R-18
  r18: 'exclude' | 'only'
  limit: number
  // 语义那一路：按和这个向量的相似度排（只在已经有向量的图里找），低于 minSimilarity 的不要
  vector?: { values: number[]; model: string; minSimilarity: number }
}

// 检索结果：按导入时间从新到旧的图片 id（最多 limit 张）和总数
export interface AiSearchHit {
  ids: number[]
  total: number
}

// 已确认的标签
const acceptedTag = sql`${imageTag.deleteState} = 0 and ${imageTag.status} = 'ACCEPTED'`

// 图片至少有一个活着的位置（在目录范围内）
function aliveIn(dirs: AiSearchFilter['dirs']): SQL {
  const dirCond =
    dirs && dirs.length > 0
      ? sql` and (${sql.join(
          dirs.map((d) =>
            d.prefix
              ? sql`(${col(imageFile.rootId)} = ${d.rootId} and lower(${col(imageFile.relPath)}) like ${likeEscape(d.prefix.toLowerCase()) + '\\\\%'})`
              : sql`${col(imageFile.rootId)} = ${d.rootId}`
          ),
          sql` or `
        )})`
      : sql``
  return sql`exists (select 1 from ${imageFile} join ${libraryRoot} on ${col(libraryRoot.id)} = ${col(imageFile.rootId)}
    where ${col(imageFile.imageId)} = ${col(image.id)} and ${col(imageFile.deleteState)} = 0 and ${col(imageFile.status)} <> 'DELETED'
    and ${col(libraryRoot.deleteState)} = 0${dirCond})`
}

// 带其中任一标签
function hasAnyTag(ids: number[]): SQL {
  return sql`exists (select 1 from ${imageTag} where ${col(imageTag.imageId)} = ${col(image.id)} and ${acceptedTag} and ${inArray(imageTag.tagId, ids)})`
}

// 一个关键词：名字、描述、文件名、标签名、别名里出现就算
function keywordHit(word: string): SQL {
  const p = `%${likeEscape(word)}%`
  return sql`(lower(coalesce(${image.displayName}, '')) like ${p}
    or lower(coalesce(${image.description}, '')) like ${p}
    or exists (select 1 from ${imageFile} where ${col(imageFile.imageId)} = ${col(image.id)} and ${col(imageFile.deleteState)} = 0 and lower(${col(imageFile.relPath)}) like ${p})
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

// 按条件找图，只要没删的图
export async function searchImages(f: AiSearchFilter): Promise<AiSearchHit> {
  const { db } = getDatabase()
  const conds: Array<SQL | undefined> = [eq(image.deleteState, 0), aliveIn(f.dirs), eq(image.isR18, f.r18 === 'only')]
  for (const group of f.tagGroups) {
    conds.push(group.length > 0 ? hasAnyTag(group) : sql`false`)
  }
  if (f.keywords.length > 0) {
    conds.push(sql`(${sql.join(f.keywords.map(keywordHit), sql` or `)})`)
  }
  if (f.orientation) {
    conds.push(orientationOf(f.orientation))
  }
  if (f.recentDays !== undefined) {
    conds.push(sql`${image.createTime} >= now() - make_interval(days => ${f.recentDays})`)
  }
  if (f.untagged) {
    conds.push(sql`not exists (select 1 from ${imageTag} where ${col(imageTag.imageId)} = ${col(image.id)} and ${acceptedTag})`)
  }
  if (f.vector) {
    // 余弦距离 = 1 - 相似度；向量用字面量传进去
    const lit = `[${f.vector.values.join(',')}]`
    const distance = sql<number>`(select ${col(imageEmbedding.embedding)} <=> ${lit}::vector from ${imageEmbedding}
      where ${col(imageEmbedding.imageId)} = ${col(image.id)} and ${col(imageEmbedding.model)} = ${f.vector.model} and ${col(imageEmbedding.deleteState)} = 0 limit 1)`
    conds.push(sql`${distance} <= ${1 - f.vector.minSimilarity}`)
    const rows = await db
      .select({ id: image.id, total: sql<number>`count(*) over ()::int` })
      .from(image)
      .where(and(...conds))
      .orderBy(distance, desc(image.id))
      .limit(f.limit)
    return { ids: rows.map((r) => r.id), total: rows[0]?.total ?? 0 }
  }
  const rows = await db
    .select({ id: image.id, total: sql<number>`count(*) over ()::int` })
    .from(image)
    .where(and(...conds))
    .orderBy(desc(image.createTime), desc(image.id))
    .limit(f.limit)
  return { ids: rows.map((r) => r.id), total: rows[0]?.total ?? 0 }
}

// 还没有向量、又过了上云闸门的图（本地模型判过且不是明显 R-18，或你手动关过 R-18），先导入的先做
export async function findEmbedCandidates(model: string, limit: number): Promise<number[]> {
  const { db } = getDatabase()
  const hasVec = sql`exists (select 1 from ${imageEmbedding} where ${col(imageEmbedding.imageId)} = ${col(image.id)} and ${col(imageEmbedding.model)} = ${model} and ${col(imageEmbedding.deleteState)} = 0)`
  const rows = await db
    .select({ id: image.id })
    .from(image)
    .where(
      and(
        eq(image.deleteState, 0),
        eq(image.isR18, false),
        sql`(${image.ratingSource} = 'MANUAL' or (${image.ratingSource} = 'MODEL' and ${image.rating} in ('GENERAL', 'SENSITIVE')))`,
        sql`not ${hasVec}`
      )
    )
    .orderBy(image.id)
    .limit(limit)
  return rows.map((r) => r.id)
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

// 标签词表：每个标签的名字、别名、分类，以及是否用在至少一张非 R-18 图上
export async function findVocabulary(): Promise<Array<{ id: number; name: string; categoryId: number; aliases: string[]; general: boolean }>> {
  const { db } = getDatabase()
  const general = sql<boolean>`exists (select 1 from ${imageTag} join ${image} on ${col(image.id)} = ${col(imageTag.imageId)}
    where ${col(imageTag.tagId)} = ${col(tag.id)} and ${acceptedTag} and ${col(image.deleteState)} = 0 and ${col(image.isR18)} = false)`
  const tags = await db.select({ id: tag.id, name: tag.name, categoryId: tag.categoryId, general }).from(tag).where(eq(tag.deleteState, 0)).orderBy(tag.id)
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

// 目录名：源目录名和类目录的顶层文件夹名（本地路由匹配“某某目录里的”）
export async function findDirNames(): Promise<Array<{ rootId: number; kind: 'SOURCE' | 'CATEGORY'; name: string }>> {
  const { db } = getDatabase()
  const roots = await db
    .select({ id: libraryRoot.id, kind: libraryRoot.kind, name: libraryRoot.name })
    .from(libraryRoot)
    .where(eq(libraryRoot.deleteState, 0))
  const out: Array<{ rootId: number; kind: 'SOURCE' | 'CATEGORY'; name: string }> = roots
    .filter((r) => r.kind === 'SOURCE')
    .map((r) => ({ rootId: r.id, kind: 'SOURCE', name: r.name }))
  const cat = roots.find((r) => r.kind === 'CATEGORY')
  if (cat) {
    const tops = await db
      .selectDistinct({ top: sql<string>`split_part(${imageFile.relPath}, '\\', 1)` })
      .from(imageFile)
      .where(and(eq(imageFile.rootId, cat.id), eq(imageFile.deleteState, 0), sql`strpos(${imageFile.relPath}, '\\') > 0`))
    for (const t of tops) {
      out.push({ rootId: cat.id, kind: 'CATEGORY', name: t.top })
    }
  }
  return out
}

// 一张图给模型看的信息：名字、文件名、尺寸、是否 R-18
export async function findImageBrief(
  imageId: number
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
      relPath: sql<string | null>`(select ${col(imageFile.relPath)} from ${imageFile} where ${col(imageFile.imageId)} = ${col(image.id)} and ${col(imageFile.deleteState)} = 0 order by ${col(imageFile.id)} limit 1)`
    })
    .from(image)
    .where(and(eq(image.id, imageId), eq(image.deleteState, 0)))
    .limit(1)
  return row
}
