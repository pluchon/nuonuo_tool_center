import { and, eq, ne, sql } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { image, imageFile, imageTag, tag } from '../db/schema'

// 侧栏用的各项计数（未拆出“还没打标签”，由服务层用 total - tagged 得到）
export interface OverviewCounts {
  total: number
  tagged: number
  recent: number
  r18: number
  tags: number
}

// 还“活着”的图片：至少有一个没删除的文件位置（找不到的也算，界面上显示为灰色）
const aliveImage = sql`exists (select 1 from ${imageFile} where ${imageFile.imageId} = ${image.id} and ${imageFile.deleteState} = 0 and ${imageFile.status} <> 'DELETED')`

// 打过标签：至少有一个已确认的标签
const taggedImage = sql`exists (select 1 from ${imageTag} where ${imageTag.imageId} = ${image.id} and ${imageTag.deleteState} = 0 and ${imageTag.status} = 'ACCEPTED')`

// 一条 SQL 合并统计图片计数，另一条统计标签数
export async function countOverview(recentDays: number): Promise<OverviewCounts> {
  const { db } = getDatabase()
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      tagged: sql<number>`(count(*) filter (where ${taggedImage}))::int`,
      recent: sql<number>`(count(*) filter (where ${image.createTime} >= now() - make_interval(days => ${recentDays})))::int`,
      r18: sql<number>`(count(*) filter (where ${image.isR18}))::int`
    })
    .from(image)
    .where(and(eq(image.deleteState, 0), aliveImage))
  const tags = await db.$count(tag, eq(tag.deleteState, 0))
  return { total: row.total, tagged: row.tagged, recent: row.recent, r18: row.r18, tags }
}

// 每个目录下的图片数（同一内容在目录里有多个文件只算一张）
export async function countImagesByRoot(): Promise<Map<number, number>> {
  const { db } = getDatabase()
  const rows = await db
    .select({ rootId: imageFile.rootId, n: sql<number>`count(distinct ${imageFile.imageId})::int` })
    .from(imageFile)
    .where(and(eq(imageFile.deleteState, 0), ne(imageFile.status, 'DELETED')))
    .groupBy(imageFile.rootId)
  return new Map(rows.map((r) => [r.rootId, r.n]))
}

// 类目录根下每个顶层文件夹的图片数
export async function countImagesByTopFolder(rootId: number): Promise<Map<string, number>> {
  const { db } = getDatabase()
  const top = sql<string>`split_part(${imageFile.relPath}, '\\', 1)`
  const rows = await db
    .select({ top, n: sql<number>`count(distinct ${imageFile.imageId})::int` })
    .from(imageFile)
    .where(and(eq(imageFile.rootId, rootId), eq(imageFile.deleteState, 0), ne(imageFile.status, 'DELETED')))
    .groupBy(top)
  return new Map(rows.map((r) => [r.top.toLowerCase(), r.n]))
}
