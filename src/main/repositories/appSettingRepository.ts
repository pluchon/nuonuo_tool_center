import { eq, sql } from 'drizzle-orm'
import { getDatabase } from '../db/client'
import { appSetting } from '../db/schema'

export type AppSettingEntity = typeof appSetting.$inferSelect

// 读取全部未删除的设置行
export async function findActiveSettings(): Promise<AppSettingEntity[]> {
  const { db } = getDatabase()
  return db.select().from(appSetting).where(eq(appSetting.deleteState, 0))
}

// 在一个事务里写入多项设置：按 key 存在则更新，不存在则新增
export async function upsertSettings(entries: Array<{ key: string; value: unknown }>): Promise<void> {
  const { db } = getDatabase()
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx
        .insert(appSetting)
        .values({ key: entry.key, value: entry.value })
        .onConflictDoUpdate({
          target: appSetting.key,
          targetWhere: sql`${appSetting.deleteState} = 0`,
          set: { value: entry.value, updateTime: new Date() }
        })
    }
  })
}
