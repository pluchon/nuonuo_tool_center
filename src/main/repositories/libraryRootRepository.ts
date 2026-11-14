import { asc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { libraryRoot } from '../db/schema'

export type LibraryRootEntity = typeof libraryRoot.$inferSelect
export type NewLibraryRoot = typeof libraryRoot.$inferInsert

// 查询全部未删除的图库目录，按创建顺序
export async function findActiveRoots(): Promise<LibraryRootEntity[]> {
  const { db } = getDatabase()
  return db.select().from(libraryRoot).where(eq(libraryRoot.deleteState, 0)).orderBy(asc(libraryRoot.id))
}

// 新增图库目录
export async function insertRoot(root: NewLibraryRoot): Promise<LibraryRootEntity> {
  const { db } = getDatabase()
  const [created] = await db.insert(libraryRoot).values(root).returning()
  return created
}
