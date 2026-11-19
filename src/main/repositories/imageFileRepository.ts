import { and, eq, inArray, ne, notInArray } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { image, imageFile } from '../db/schema'

export type ImageFileEntity = typeof imageFile.$inferSelect

// 扫描对账用的一条文件记录：带上图片的字节数和缩略图状态，用来判断文件有没有变
export interface ScanFileRow {
  id: number
  imageId: number
  relPath: string
  mtime: Date
  status: ImageFileEntity['status']
  byteSize: number
  thumbReady: number
}

// 某个目录下全部未删除的文件记录（含 MISSING；DELETED 是用户自己删进回收站的，不参与对账）
export async function findScanRowsByRoot(rootId: number): Promise<ScanFileRow[]> {
  const { db } = getDatabase()
  return db
    .select({
      id: imageFile.id,
      imageId: imageFile.imageId,
      relPath: imageFile.relPath,
      mtime: imageFile.mtime,
      status: imageFile.status,
      byteSize: image.byteSize,
      thumbReady: image.thumbReady
    })
    .from(imageFile)
    .innerJoin(image, eq(image.id, imageFile.imageId))
    .where(and(eq(imageFile.rootId, rootId), eq(imageFile.deleteState, 0), ne(imageFile.status, 'DELETED')))
}

// 新增文件记录
export async function insertImageFile(row: { imageId: number; rootId: number; relPath: string; mtime: Date }): Promise<void> {
  const { db } = getDatabase()
  await db.insert(imageFile).values({ ...row, status: 'NORMAL' })
}

// 文件内容或路径大小写变了：改指向的图片、路径和修改时间，状态回到正常
export async function updateImageFileContent(id: number, patch: { imageId: number; relPath: string; mtime: Date }): Promise<void> {
  const { db } = getDatabase()
  await db
    .update(imageFile)
    .set({ ...patch, status: 'NORMAL' })
    .where(eq(imageFile.id, id))
}

// 批量改状态（找不到的文件重新出现时改回 NORMAL，文件真不见了改成 MISSING）
export async function updateImageFileStatus(ids: number[], status: ImageFileEntity['status']): Promise<void> {
  if (ids.length === 0) {
    return
  }
  const { db } = getDatabase()
  await db.update(imageFile).set({ status }).where(inArray(imageFile.id, ids))
}

// 批量逻辑删除文件记录（文件被移到了别处、内容已在别的位置找到）
export async function softDeleteImageFiles(ids: number[]): Promise<void> {
  if (ids.length === 0) {
    return
  }
  const { db } = getDatabase()
  await db.update(imageFile).set({ deleteState: 1 }).where(inArray(imageFile.id, ids))
}

// 这些图片里，哪些在给定记录之外还有正常的文件位置
export async function findImagesWithOtherNormalFile(imageIds: number[], excludeFileIds: number[]): Promise<Set<number>> {
  if (imageIds.length === 0) {
    return new Set()
  }
  const { db } = getDatabase()
  const rows = await db
    .selectDistinct({ imageId: imageFile.imageId })
    .from(imageFile)
    .where(
      and(
        inArray(imageFile.imageId, imageIds),
        eq(imageFile.deleteState, 0),
        eq(imageFile.status, 'NORMAL'),
        excludeFileIds.length > 0 ? notInArray(imageFile.id, excludeFileIds) : undefined
      )
    )
  return new Set(rows.map((r) => r.imageId))
}
