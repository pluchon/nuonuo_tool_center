import { eq, inArray } from 'drizzle-orm'
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
  await db.update(image).set({ isR18 }).where(inArray(image.id, ids))
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
