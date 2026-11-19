import { and, asc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { libraryRoot } from '../db/schema'

export type LibraryRootEntity = typeof libraryRoot.$inferSelect
export type NewLibraryRoot = typeof libraryRoot.$inferInsert

// 查询全部未删除的目录（源目录和类目录），按创建顺序
export async function findActiveRoots(): Promise<LibraryRootEntity[]> {
  const { db } = getDatabase()
  return db.select().from(libraryRoot).where(eq(libraryRoot.deleteState, 0)).orderBy(asc(libraryRoot.id))
}

// 查询某一类未删除的目录，按创建顺序
export async function findActiveRootsByKind(kind: LibraryRootEntity['kind']): Promise<LibraryRootEntity[]> {
  const { db } = getDatabase()
  return db
    .select()
    .from(libraryRoot)
    .where(and(eq(libraryRoot.deleteState, 0), eq(libraryRoot.kind, kind)))
    .orderBy(asc(libraryRoot.id))
}

// 按 id 查未删除的目录
export async function findActiveRootById(id: number): Promise<LibraryRootEntity | undefined> {
  const { db } = getDatabase()
  const [row] = await db
    .select()
    .from(libraryRoot)
    .where(and(eq(libraryRoot.id, id), eq(libraryRoot.deleteState, 0)))
    .limit(1)
  return row
}

// 改目录位置（源目录“重新选择”、类目录位置变了）
export async function updateRootPath(id: number, path: string): Promise<LibraryRootEntity> {
  const { db } = getDatabase()
  const [row] = await db.update(libraryRoot).set({ path }).where(eq(libraryRoot.id, id)).returning()
  return row
}

// 记下目录最近一次完整扫描完成的时间
export async function updateRootLastScan(id: number, at: Date): Promise<void> {
  const { db } = getDatabase()
  await db.update(libraryRoot).set({ lastScanAt: at }).where(eq(libraryRoot.id, id))
}

// 新增目录
export async function insertRoot(root: NewLibraryRoot): Promise<LibraryRootEntity> {
  const { db } = getDatabase()
  const [created] = await db.insert(libraryRoot).values(root).returning()
  return created
}
