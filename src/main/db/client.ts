import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from './schema'

export type AppDatabase = PgliteDatabase<typeof schema>

// 数据库句柄：PGlite 只有一条连接，由主进程独占
export interface DatabaseHandle {
  pg: PGlite
  db: AppDatabase
}

let handle: DatabaseHandle | null = null

// 打开数据库、启用扩展并执行迁移；扩展必须先于迁移创建，因为表里有 vector 列。中途失败会关掉已打开的连接
export async function openDatabase(dataDir: string, migrationsFolder: string): Promise<DatabaseHandle> {
  if (handle) {
    return handle
  }
  const pg = await PGlite.create(dataDir, { extensions: { vector } })
  try {
    await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;')
    const db = drizzle({ client: pg, schema })
    await migrate(db, { migrationsFolder })
    handle = { pg, db }
    return handle
  } catch (err) {
    await pg.close().catch(() => undefined)
    throw err
  }
}

// 数据库是否已经打开
export function isDatabaseOpen(): boolean {
  return handle !== null
}

// 取得已打开的数据库；未初始化时抛错，避免静默使用空连接
export function getDatabase(): DatabaseHandle {
  if (!handle) {
    throw new Error('数据库尚未初始化')
  }
  return handle
}

// 关闭数据库，退出前调用以确保数据落盘
export async function closeDatabase(): Promise<void> {
  if (handle) {
    const current = handle
    handle = null
    await current.pg.close()
  }
}
