import { and, eq, ne, sql } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { col, likeEscape } from '../db/sqlUtil'
import { image, imageFile, imageTag, tag } from '../db/schema'
import { hasPendingSuggestion } from './aiResultRepository'

// 侧栏用的各项计数（未拆出“还没打标签”，由服务层用 total - tagged 得到）
export interface OverviewCounts {
  total: number
  tagged: number
  recent: number
  r18: number
  tags: number
  aiSuggest: number
}

// 还“活着”的图片：至少有一个没删除的文件位置（找不到的也算，界面上显示为灰色）
const aliveImage = sql`exists (select 1 from ${imageFile} where ${col(imageFile.imageId)} = ${col(image.id)} and ${imageFile.deleteState} = 0 and ${imageFile.status} <> 'DELETED')`

// 打过标签：至少有一个已确认的标签
const taggedImage = sql`exists (select 1 from ${imageTag} where ${col(imageTag.imageId)} = ${col(image.id)} and ${imageTag.deleteState} = 0 and ${imageTag.status} = 'ACCEPTED')`

// 一条 SQL 合并统计图片计数，另一条统计标签数
export async function countOverview(recentDays: number): Promise<OverviewCounts> {
  const { db } = getDatabase()
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      tagged: sql<number>`(count(*) filter (where ${taggedImage}))::int`,
      recent: sql<number>`(count(*) filter (where ${image.createTime} >= now() - make_interval(days => ${recentDays})))::int`,
      r18: sql<number>`(count(*) filter (where ${image.isR18}))::int`,
      aiSuggest: sql<number>`(count(*) filter (where ${hasPendingSuggestion}))::int`
    })
    .from(image)
    .where(and(eq(image.deleteState, 0), aliveImage))
  const tags = await db.$count(tag, eq(tag.deleteState, 0))
  return { total: row.total, tagged: row.tagged, recent: row.recent, r18: row.r18, tags, aiSuggest: row.aiSuggest }
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

// 某个目录（prefix 为相对根目录的路径，空串表示根目录本身）下每个直接子文件夹的图片数（含更深的子目录）
export async function countImagesByChildFolder(rootId: number, prefix: string): Promise<Map<string, number>> {
  const { db } = getDatabase()
  const rest = prefix ? sql`substr(${imageFile.relPath}, ${prefix.length + 2})` : sql`${imageFile.relPath}`
  const child = sql<string>`split_part(${rest}, '\\', 1)`
  const conds = [eq(imageFile.rootId, rootId), eq(imageFile.deleteState, 0), ne(imageFile.status, 'DELETED'), sql`strpos(${rest}, '\\') > 0`]
  if (prefix) {
    conds.push(sql`lower(${imageFile.relPath}) like ${likeEscape(prefix.toLowerCase()) + '\\\\%'}`)
  }
  const rows = await db
    .select({ child, n: sql<number>`count(distinct ${imageFile.imageId})::int` })
    .from(imageFile)
    .where(and(...conds))
    // 按第 1 列分组：子路径表达式里带参数，select 和 group by 里各算一个占位符，Postgres 认不出是同一个表达式
    .groupBy(sql`1`)
  return new Map(rows.map((r) => [r.child.toLowerCase(), r.n]))
}
