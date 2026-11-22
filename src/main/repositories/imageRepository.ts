import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { image } from '../db/schema'

export type ImageEntity = typeof image.$inferSelect
export type NewImage = typeof image.$inferInsert

// 缩略图状态：0 还没生成，1 已生成，2 生成失败（无法预览）
export const THUMB_PENDING = 0
export const THUMB_READY = 1
export const THUMB_FAILED = 2

// 按内容哈希查图片（含逻辑删除的，便于重新出现时恢复）
export async function findImageByHash(contentHash: string): Promise<ImageEntity | undefined> {
  const { db } = getDatabase()
  const [row] = await db.select().from(image).where(eq(image.contentHash, contentHash)).limit(1)
  return row
}

// 新建图片；同一哈希已被别处并发写入时返回已有的那条
export async function insertImageOrGet(row: NewImage): Promise<ImageEntity> {
  const { db } = getDatabase()
  const [created] = await db.insert(image).values(row).onConflictDoNothing({ target: image.contentHash }).returning()
  if (created) {
    return created
  }
  const existing = await findImageByHash(row.contentHash)
  if (!existing) {
    throw new Error(`图片写入冲突后查不到：${row.contentHash}`)
  }
  return existing
}

// 更新图片的解析结果（尺寸、拍摄信息、缩略图状态），逻辑删除的一并恢复
export async function updateImageAnalysis(
  id: number,
  patch: Pick<NewImage, 'width' | 'height' | 'exif' | 'takenAt' | 'thumbReady'>
): Promise<void> {
  const { db } = getDatabase()
  await db
    .update(image)
    .set({ ...patch, deleteState: 0 })
    .where(eq(image.id, id))
}

// 改名字（null 表示用回文件名）
export async function updateDisplayName(id: number, displayName: string | null): Promise<void> {
  const { db } = getDatabase()
  await db.update(image).set({ displayName }).where(eq(image.id, id))
}

// 批量设置 R-18
export async function updateR18(ids: number[], isR18: boolean): Promise<void> {
  const { db } = getDatabase()
  // 手动开关过的图记成 MANUAL：本地模型以后不再改它
  await db.update(image).set({ isR18, ratingSource: 'MANUAL' }).where(inArray(image.id, ids))
}

// 还没分级过的图（手动开关过的、缩略图没生成好的不算），先导入的先判
export async function findRatingCandidates(limit: number): Promise<Array<{ id: number; contentHash: string }>> {
  const { db } = getDatabase()
  return db
    .select({ id: image.id, contentHash: image.contentHash })
    .from(image)
    .where(and(eq(image.deleteState, 0), isNull(image.ratingSource), eq(image.thumbReady, THUMB_READY)))
    .orderBy(asc(image.id))
    .limit(limit)
}

// 还有多少张等着本地分级（进度条的分母）
export async function countRatingCandidates(): Promise<number> {
  const { db } = getDatabase()
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(image)
    .where(and(eq(image.deleteState, 0), isNull(image.ratingSource), eq(image.thumbReady, THUMB_READY)))
  return Number(row?.n ?? 0)
}

// 记下本地模型的分级；只在这张图还没被手动开关过时写（和手动操作并发时手动的赢），返回是否写入
export async function saveModelRating(
  id: number,
  rating: 'UNKNOWN' | 'GENERAL' | 'SENSITIVE' | 'QUESTIONABLE' | 'EXPLICIT',
  scores: unknown,
  isR18: boolean
): Promise<boolean> {
  const { db } = getDatabase()
  const rows = await db
    .update(image)
    .set({ rating, ratingScores: scores, ratingSource: 'MODEL', ...(isR18 ? { isR18: true } : {}) })
    .where(and(eq(image.id, id), isNull(image.ratingSource)))
    .returning({ id: image.id })
  return rows.length > 0
}

// 只更新缩略图状态
export async function updateImageThumb(id: number, thumbReady: number): Promise<void> {
  const { db } = getDatabase()
  await db.update(image).set({ thumbReady }).where(eq(image.id, id))
}

// 全部图片的内容哈希（含逻辑删除的：它们还可能被恢复，缩略图留着）
export async function findAllContentHashes(): Promise<string[]> {
  const { db } = getDatabase()
  const rows = await db.select({ h: image.contentHash }).from(image)
  return rows.map((r) => r.h)
}
