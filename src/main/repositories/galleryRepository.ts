import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { col, likeEscape } from '../db/sqlUtil'
import { image, imageFile, imageTag, libraryRoot, tag } from '../db/schema'

// 网格查询的一行：一个文件位置连同它的图片
export interface GalleryRow {
  imageId: number
  fileId: number
  rootId: number
  rootPath: string
  relPath: string
  fileStatus: 'NORMAL' | 'MISSING' | 'DELETED'
  displayName: string | null
  format: string
  width: number | null
  height: number | null
  byteSize: number
  contentHash: string
  thumbReady: number
  isR18: boolean
  tagged: boolean
  createTime: Date
  takenAt: Date | null
}

// 查询条件（服务层已经校验和规范化过）
export interface GalleryFilter {
  // 视图条件：all 只要打过标签的，untagged 只要没打过的，recent 只要最近 N 天导入的，r18 只要 R-18
  scope: 'all' | 'untagged' | 'recent' | 'r18' | 'dir'
  recentDays: number
  // 目录条件：哪个目录、相对路径前缀（不含结尾反斜杠，空串表示整个目录）、是否不含子目录
  rootId?: number
  prefix?: string
  onlyHere?: boolean
  // 搜索词（已转小写）；byTag 为 true 时标签名命中也算
  q?: string
  byTag?: boolean
  onlyR18?: boolean
  // 带其中任一标签
  tagIds?: number[]
  // 文件在其中任一目录里：整个源目录，或某个目录下以 prefix 开头的子路径
  dirs?: Array<{ rootId: number; prefix: string }>
}

// 打过标签：至少有一个已确认的标签
const taggedExpr = sql<boolean>`exists (select 1 from ${imageTag} where ${col(imageTag.imageId)} = ${col(image.id)} and ${imageTag.deleteState} = 0 and ${imageTag.status} = 'ACCEPTED')`

// 文件名：相对路径最后一段
const fileNameExpr = sql<string>`regexp_replace(${imageFile.relPath}, '^.*\\\\', '')`

// 网格行要查的列
const ROW_COLUMNS = {
  imageId: image.id,
  fileId: imageFile.id,
  rootId: imageFile.rootId,
  rootPath: libraryRoot.path,
  relPath: imageFile.relPath,
  fileStatus: imageFile.status,
  displayName: image.displayName,
  format: image.format,
  width: image.width,
  height: image.height,
  byteSize: image.byteSize,
  contentHash: image.contentHash,
  thumbReady: image.thumbReady,
  isR18: image.isR18,
  tagged: taggedExpr,
  createTime: image.createTime,
  takenAt: image.takenAt
}


// 按条件查文件位置：只要未删除、没进回收站的文件和未删除的图片
export async function findGalleryRows(f: GalleryFilter): Promise<GalleryRow[]> {
  const { db } = getDatabase()
  const conds: Array<SQL | undefined> = [
    eq(imageFile.deleteState, 0),
    ne(imageFile.status, 'DELETED'),
    eq(image.deleteState, 0),
    eq(libraryRoot.deleteState, 0)
  ]
  if (f.scope === 'all') {
    conds.push(taggedExpr)
  } else if (f.scope === 'untagged') {
    conds.push(sql`not ${taggedExpr}`)
  } else if (f.scope === 'recent') {
    conds.push(sql`${image.createTime} >= now() - make_interval(days => ${f.recentDays})`)
  } else if (f.scope === 'r18') {
    conds.push(eq(image.isR18, true))
  }
  if (f.rootId !== undefined) {
    conds.push(eq(imageFile.rootId, f.rootId))
    const prefix = f.prefix ?? ''
    const rest = prefix ? sql`substr(${imageFile.relPath}, ${prefix.length + 2})` : sql`${imageFile.relPath}`
    if (prefix) {
      conds.push(sql`lower(${imageFile.relPath}) like ${likeEscape(prefix.toLowerCase()) + '\\\\%'}`)
    }
    if (f.onlyHere) {
      conds.push(sql`strpos(${rest}, '\\') = 0`)
    }
  }
  if (f.onlyR18) {
    conds.push(eq(image.isR18, true))
  }
  if (f.tagIds && f.tagIds.length > 0) {
    conds.push(
      sql`exists (select 1 from ${imageTag} where ${col(imageTag.imageId)} = ${col(image.id)} and ${imageTag.deleteState} = 0 and ${imageTag.status} = 'ACCEPTED' and ${inArray(imageTag.tagId, f.tagIds)})`
    )
  }
  if (f.dirs && f.dirs.length > 0) {
    conds.push(
      or(
        ...f.dirs.map((d) =>
          d.prefix
            ? and(eq(imageFile.rootId, d.rootId), sql`lower(${imageFile.relPath}) like ${likeEscape(d.prefix.toLowerCase()) + '\\\\%'}`)
            : eq(imageFile.rootId, d.rootId)
        )
      )
    )
  }
  if (f.q) {
    const pattern = `%${likeEscape(f.q)}%`
    const nameHit = sql`lower(coalesce(${image.displayName}, ${fileNameExpr})) like ${pattern}`
    const tagHit = sql`exists (select 1 from ${imageTag} join ${tag} on ${col(tag.id)} = ${col(imageTag.tagId)} where ${col(imageTag.imageId)} = ${col(image.id)} and ${imageTag.deleteState} = 0 and ${imageTag.status} = 'ACCEPTED' and ${tag.deleteState} = 0 and lower(${tag.name}) like ${pattern})`
    conds.push(f.byTag ? sql`(${nameHit} or ${tagHit})` : nameHit)
  }
  return db
    .select(ROW_COLUMNS)
    .from(imageFile)
    .innerJoin(image, eq(image.id, imageFile.imageId))
    .innerJoin(libraryRoot, eq(libraryRoot.id, imageFile.rootId))
    .where(and(...conds))
    .orderBy(imageFile.id)
}

// 一张图的全部位置和图片本身（详情面板）
export async function findImageRows(imageId: number): Promise<GalleryRow[]> {
  const { db } = getDatabase()
  return db
    .select(ROW_COLUMNS)
    .from(imageFile)
    .innerJoin(image, eq(image.id, imageFile.imageId))
    .innerJoin(libraryRoot, eq(libraryRoot.id, imageFile.rootId))
    .where(
      and(
        eq(image.id, imageId),
        eq(image.deleteState, 0),
        eq(imageFile.deleteState, 0),
        ne(imageFile.status, 'DELETED'),
        eq(libraryRoot.deleteState, 0)
      )
    )
    .orderBy(imageFile.id)
}

// 这些图在磁盘上的全部位置（没进回收站的）
export async function findRowsOfImages(imageIds: number[]): Promise<GalleryRow[]> {
  if (imageIds.length === 0) {
    return []
  }
  const { db } = getDatabase()
  return db
    .select(ROW_COLUMNS)
    .from(imageFile)
    .innerJoin(image, eq(image.id, imageFile.imageId))
    .innerJoin(libraryRoot, eq(libraryRoot.id, imageFile.rootId))
    .where(
      and(
        inArray(image.id, imageIds),
        eq(image.deleteState, 0),
        eq(imageFile.deleteState, 0),
        ne(imageFile.status, 'DELETED'),
        eq(libraryRoot.deleteState, 0)
      )
    )
    .orderBy(imageFile.id)
}

// 一张图的拍摄信息和分级来源（详情面板用）
export async function findImageExtras(imageId: number): Promise<{ exif: unknown; ratingSource: 'MODEL' | 'MANUAL' | null }> {
  const { db } = getDatabase()
  const [row] = await db.select({ exif: image.exif, ratingSource: image.ratingSource }).from(image).where(eq(image.id, imageId)).limit(1)
  return { exif: row?.exif ?? null, ratingSource: row?.ratingSource ?? null }
}

// 按 id 查一个文件位置的绝对路径所需信息
export async function findFileLocation(fileId: number): Promise<{ rootPath: string; relPath: string } | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .select({ rootPath: libraryRoot.path, relPath: imageFile.relPath })
    .from(imageFile)
    .innerJoin(libraryRoot, eq(libraryRoot.id, imageFile.rootId))
    .where(and(eq(imageFile.id, fileId), eq(imageFile.deleteState, 0), eq(libraryRoot.deleteState, 0)))
    .limit(1)
  return row
}

// “还没打标签”的图在各目录（源目录、类目录顶层文件夹）里有多少张
export async function countUntaggedByDir(): Promise<Array<{ rootId: number; kind: 'SOURCE' | 'CATEGORY'; name: string; top: string; n: number }>> {
  const { db } = getDatabase()
  const top = sql<string>`case when ${libraryRoot.kind} = 'CATEGORY' then split_part(${imageFile.relPath}, '\\', 1) else '' end`
  return db
    .select({
      rootId: libraryRoot.id,
      kind: libraryRoot.kind,
      name: libraryRoot.name,
      top,
      n: sql<number>`count(distinct ${image.id})::int`
    })
    .from(imageFile)
    .innerJoin(image, eq(image.id, imageFile.imageId))
    .innerJoin(libraryRoot, eq(libraryRoot.id, imageFile.rootId))
    .where(
      and(
        eq(imageFile.deleteState, 0),
        ne(imageFile.status, 'DELETED'),
        eq(image.deleteState, 0),
        eq(libraryRoot.deleteState, 0),
        sql`not ${taggedExpr}`,
        // 类目录根下直接放的文件不属于任何类目录
        sql`(${libraryRoot.kind} = 'SOURCE' or strpos(${imageFile.relPath}, '\\') > 0)`
      )
    )
    .groupBy(libraryRoot.id, libraryRoot.kind, libraryRoot.name, top)
    .orderBy(libraryRoot.id, top)
}
