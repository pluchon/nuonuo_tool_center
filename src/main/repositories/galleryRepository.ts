import { and, asc, between, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { MoreFilterDTO } from '@shared/api'
import type { SortKey } from '@shared/settings'
import { getDatabase } from '../db/client'
import { col, likeEscape } from '../db/sqlUtil'
import { image, imageFile, imageTag, libraryRoot, tag } from '../db/schema'
import { hasPendingR18Review, hasPendingSuggestion } from './aiResultRepository'
import { categoryPosition, confirmedForSearch, type AiSearchFilter } from './aiSearchRepository'

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
  scope: 'all' | 'untagged' | 'recent' | 'r18' | 'ai' | 'dir'
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
  // 更多筛选条件与排序方式（下推到 PG）
  more?: MoreFilterDTO
  sort?: SortKey
  now?: Date
}

const ONE_MB = 1024 * 1024
const TEN_MB = 10 * ONE_MB
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000

// 将「更多筛选」条件转成 PG WHERE 子句，与服务层 matchMore 语义保持一致
function moreConditions(more: MoreFilterDTO, base: Date): Array<SQL | undefined> {
  const conds: Array<SQL | undefined> = []
  if (more.fmt && more.fmt.length > 0) {
    conds.push(inArray(image.format, more.fmt))
  }
  if (more.ori && more.ori.length > 0) {
    const ratio = sql`(${image.width}::double precision / ${image.height})`
    conds.push(
      and(
        gt(image.width, 0),
        gt(image.height, 0),
        or(
          ...more.ori.map((v) =>
            v === 'h'
              ? sql`${ratio} > 1.05`
              : v === 'v'
                ? sql`${ratio} < 0.95`
                : sql`${ratio} between 0.95 and 1.05`
          )
        )
      )
    )
  }
  if (more.res && more.res.length > 0) {
    const longEdge = sql`greatest(coalesce(${image.width}, 0), coalesce(${image.height}, 0))`
    conds.push(
      and(
        sql`${longEdge} > 0`,
        or(
          ...more.res.map((v) =>
            v === '4k'
              ? sql`${longEdge} >= 3840`
              : v === 'fhd'
                ? sql`${longEdge} >= 1920`
                : sql`${longEdge} < 1000`
          )
        )
      )
    )
  }
  if (more.size && more.size.length > 0) {
    conds.push(
      or(
        ...more.size.map((v) =>
          v === 's' ? lt(image.byteSize, ONE_MB) : v === 'm' ? between(image.byteSize, ONE_MB, TEN_MB) : gt(image.byteSize, TEN_MB)
        )
      )
    )
  }
  if (more.date && more.date.length > 0) {
    const cutoff30d = new Date(base.getTime() - THIRTY_DAYS_MS)
    const thisYearStart = new Date(base.getFullYear(), 0, 1)
    const nextYearStart = new Date(base.getFullYear() + 1, 0, 1)
    const lastYearStart = new Date(base.getFullYear() - 1, 0, 1)
    conds.push(
      or(
        ...more.date.map((v) => {
          if (v === 'none') {
            return isNull(image.takenAt)
          }
          if (v === '30d') {
            return gte(image.takenAt, cutoff30d)
          }
          if (v === 'ly') {
            return and(gte(image.takenAt, lastYearStart), lt(image.takenAt, thisYearStart))
          }
          return and(gte(image.takenAt, thisYearStart), lt(image.takenAt, nextYearStart))
        })
      )
    )
  }
  return conds
}

// 网格排序下推到 PG；末尾总是带 imageFile.id 保证同图多位置顺序稳定
function orderColumns(sort: SortKey | undefined): SQL[] {
  if (sort === 'new') {
    return [desc(image.createTime), desc(image.id), asc(imageFile.id)]
  }
  if (sort === 'old') {
    return [asc(image.createTime), asc(image.id), asc(imageFile.id)]
  }
  if (sort === 'taken') {
    return [sql`${image.takenAt} desc nulls last`, desc(image.createTime), desc(image.id), asc(imageFile.id)]
  }
  if (sort === 'size') {
    return [desc(image.byteSize), desc(image.createTime), desc(image.id), asc(imageFile.id)]
  }
  return [asc(imageFile.id)]
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
  } else if (f.scope === 'ai') {
    conds.push(hasPendingSuggestion)
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
  if (f.more) {
    conds.push(...moreConditions(f.more, f.now ?? new Date()))
  }
  const taggedColumn =
    f.scope === 'all' ? sql<boolean>`true` : f.scope === 'untagged' ? sql<boolean>`false` : taggedExpr
  return db
    .select({ ...ROW_COLUMNS, tagged: taggedColumn })
    .from(imageFile)
    .innerJoin(image, eq(image.id, imageFile.imageId))
    .innerJoin(libraryRoot, eq(libraryRoot.id, imageFile.rootId))
    .where(and(...conds))
    .orderBy(...orderColumns(f.sort))
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
export async function findRowsOfImages(imageIds: number[], search?: { includeR18: boolean; dirs?: AiSearchFilter['dirs']; includeOrganized?: boolean }): Promise<GalleryRow[]> {
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
        sql`${image.id} = any(${sql.param(imageIds)}::bigint[])`,
        search ? confirmedForSearch : undefined,
        search ? (search.includeOrganized ? undefined : categoryPosition(search.dirs)) : undefined,
        search && !search.includeR18 ? eq(image.isR18, false) : undefined,
        eq(image.deleteState, 0),
        eq(imageFile.deleteState, 0),
        ne(imageFile.status, 'DELETED'),
        eq(libraryRoot.deleteState, 0)
      )
    )
    .orderBy(imageFile.id)
}

// 一张图的拍摄信息和分级来源（详情面板用）
export async function findImageExtras(imageId: number): Promise<{ exif: unknown; ratingSource: 'MODEL' | 'MANUAL' | null; r18Pending: boolean }> {
  const { db } = getDatabase()
  const [row] = await db.select({ exif: image.exif, ratingSource: image.ratingSource, r18Pending: hasPendingR18Review }).from(image).where(eq(image.id, imageId)).limit(1)
  return { exif: row?.exif ?? null, ratingSource: row?.ratingSource ?? null, r18Pending: row?.r18Pending ?? false }
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
