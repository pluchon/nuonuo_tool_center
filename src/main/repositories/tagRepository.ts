import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { AppDatabase } from '../db/client'
import { getDatabase } from '../db/client'
import { col } from '../db/sqlUtil'
import { image, imageFile, imageTag, tag, tagAlias, tagCategory } from '../db/schema'

export type TagEntity = typeof tag.$inferSelect
export type TagCategoryEntity = typeof tagCategory.$inferSelect

// 事务里也能用的数据库句柄
type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
type Db = AppDatabase | Tx

// 标签用在多少张“活着”的图上（至少有一个没删的位置）
const aliveImageOf = sql`exists (select 1 from ${imageFile} where ${col(imageFile.imageId)} = ${col(imageTag.imageId)} and ${imageFile.deleteState} = 0 and ${imageFile.status} <> 'DELETED')`

// 全部分类，按排序（在事务里调用时要传事务句柄：PGlite 只有一条连接，事务外的查询会等事务结束而卡住）
export async function findCategories(dbx: Db = getDatabase().db): Promise<TagCategoryEntity[]> {
  return dbx.select().from(tagCategory).where(eq(tagCategory.deleteState, 0)).orderBy(asc(tagCategory.sortOrder), asc(tagCategory.id))
}

// 全部标签和各自的图片数（只算已确认、图还在的）
export async function findTagsWithCount(): Promise<Array<TagEntity & { count: number }>> {
  const { db } = getDatabase()
  const count = sql<number>`(select count(distinct ${col(imageTag.imageId)})::int from ${imageTag} where ${col(imageTag.tagId)} = ${col(tag.id)} and ${imageTag.deleteState} = 0 and ${imageTag.status} = 'ACCEPTED' and ${aliveImageOf})`
  const rows = await db
    .select({ tag, count })
    .from(tag)
    .where(eq(tag.deleteState, 0))
    .orderBy(asc(tag.id))
  return rows.map((r) => ({ ...r.tag, count: r.count }))
}

// 全部别名
export async function findAliases(): Promise<Array<{ tagId: number; name: string }>> {
  const { db } = getDatabase()
  return db.select({ tagId: tagAlias.tagId, name: tagAlias.name }).from(tagAlias).where(eq(tagAlias.deleteState, 0)).orderBy(asc(tagAlias.id))
}

// 按名字或别名找标签（不区分大小写）
export async function findTagByNameOrAlias(dbx: Db, name: string): Promise<TagEntity | undefined> {
  const lower = name.toLowerCase()
  const [byName] = await dbx
    .select()
    .from(tag)
    .where(and(eq(tag.deleteState, 0), sql`lower(${tag.name}) = ${lower}`))
    .limit(1)
  if (byName) {
    return byName
  }
  const [byAlias] = await dbx
    .select({ tag })
    .from(tagAlias)
    .innerJoin(tag, eq(tag.id, tagAlias.tagId))
    .where(and(eq(tagAlias.deleteState, 0), eq(tag.deleteState, 0), sql`lower(${tagAlias.name}) = ${lower}`))
    .limit(1)
  return byAlias?.tag
}

// 按 id 查分类
export async function findCategoryById(dbx: Db, id: number): Promise<TagCategoryEntity | undefined> {
  const [row] = await dbx
    .select()
    .from(tagCategory)
    .where(and(eq(tagCategory.id, id), eq(tagCategory.deleteState, 0)))
    .limit(1)
  return row
}

// 新建标签
export async function insertTag(dbx: Db, name: string, categoryId: number): Promise<TagEntity> {
  const [row] = await dbx.insert(tag).values({ name, categoryId }).returning()
  return row
}

// 这些图各自已确认的标签数
export async function countAcceptedTags(dbx: Db, imageIds: number[]): Promise<Map<number, number>> {
  const rows = await dbx
    .select({ imageId: imageTag.imageId, n: sql<number>`count(*)::int` })
    .from(imageTag)
    .where(and(inArray(imageTag.imageId, imageIds), eq(imageTag.deleteState, 0), eq(imageTag.status, 'ACCEPTED')))
    .groupBy(imageTag.imageId)
  return new Map(rows.map((r) => [r.imageId, r.n]))
}

// 这些图和某个标签的关联（未删除的，含建议和拒绝）
export async function findImageTagLinks(
  dbx: Db,
  imageIds: number[],
  tagId: number
): Promise<Array<{ id: number; imageId: number; status: 'ACCEPTED' | 'SUGGESTED' | 'REJECTED' }>> {
  return dbx
    .select({ id: imageTag.id, imageId: imageTag.imageId, status: imageTag.status })
    .from(imageTag)
    .where(and(inArray(imageTag.imageId, imageIds), eq(imageTag.tagId, tagId), eq(imageTag.deleteState, 0)))
}

// 新建手动确认的关联
export async function insertImageTags(dbx: Db, imageIds: number[], tagId: number): Promise<void> {
  if (imageIds.length === 0) {
    return
  }
  await dbx.insert(imageTag).values(imageIds.map((imageId) => ({ imageId, tagId, source: 'MANUAL' as const, status: 'ACCEPTED' as const })))
}

// 已有的建议或拒绝改成手动确认
export async function acceptImageTags(dbx: Db, linkIds: number[]): Promise<void> {
  if (linkIds.length === 0) {
    return
  }
  await dbx.update(imageTag).set({ status: 'ACCEPTED', source: 'MANUAL' }).where(inArray(imageTag.id, linkIds))
}

// 从这些图上移除标签（逻辑删除关联）
export async function removeImageTags(imageIds: number[], tagId: number): Promise<number> {
  const { db } = getDatabase()
  const rows = await db
    .update(imageTag)
    .set({ deleteState: 1 })
    .where(and(inArray(imageTag.imageId, imageIds), eq(imageTag.tagId, tagId), eq(imageTag.deleteState, 0)))
    .returning({ id: imageTag.id })
  return rows.length
}

// 一张图上已确认的标签，按加上的先后
export async function findTagsOfImage(imageId: number): Promise<Array<{ id: number; name: string; categoryId: number }>> {
  const { db } = getDatabase()
  return db
    .select({ id: tag.id, name: tag.name, categoryId: tag.categoryId })
    .from(imageTag)
    .innerJoin(tag, eq(tag.id, imageTag.tagId))
    .where(and(eq(imageTag.imageId, imageId), eq(imageTag.deleteState, 0), eq(imageTag.status, 'ACCEPTED'), eq(tag.deleteState, 0)))
    .orderBy(asc(imageTag.id))
}

// 这些图里有哪些还在库里
export async function findExistingImageIds(imageIds: number[]): Promise<number[]> {
  const { db } = getDatabase()
  const rows = await db
    .select({ id: image.id })
    .from(image)
    .where(and(inArray(image.id, imageIds), eq(image.deleteState, 0)))
  return rows.map((r) => r.id)
}

// 这些图上已确认的标签（每行一个图片和标签的组合）
export async function findTagsOfImages(imageIds: number[]): Promise<Array<{ imageId: number; id: number; name: string; categoryId: number }>> {
  const { db } = getDatabase()
  return db
    .select({ imageId: imageTag.imageId, id: tag.id, name: tag.name, categoryId: tag.categoryId })
    .from(imageTag)
    .innerJoin(tag, eq(tag.id, imageTag.tagId))
    .where(and(inArray(imageTag.imageId, imageIds), eq(imageTag.deleteState, 0), eq(imageTag.status, 'ACCEPTED'), eq(tag.deleteState, 0)))
    .orderBy(asc(imageTag.id))
}
