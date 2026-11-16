import type { DbBootState } from '@shared/api'
import { getLogger } from '../common/logger'
import { closeDatabase, isDatabaseOpen, openDatabase } from '../db/client'
import { acquireDbLock, releaseDbLock, type ProcessProbe, defaultProcessProbe } from '../db/dbLock'

const log = getLogger('database')

// 打开数据库需要的位置
export interface DatabaseLocation {
  pgdata: string
  lockFile: string
  migrationsFolder: string
}

let bootState: DbBootState = 'NOT_OPENED'

// 当前数据库状态
export function getDbBootState(): DbBootState {
  return bootState
}

// 打开图库数据库：先拿应用锁（被占用 → LOCKED），再打开并迁移（失败 → BROKEN）。失败时不删除、不重建任何数据
export async function bootDatabase(
  location: DatabaseLocation,
  probe: ProcessProbe = defaultProcessProbe
): Promise<DbBootState> {
  if (isDatabaseOpen()) {
    bootState = 'READY'
    return bootState
  }
  let locked: ReturnType<typeof acquireDbLock>
  try {
    locked = acquireDbLock(location.lockFile, probe)
  } catch (err) {
    log.error('加数据库锁失败', err)
    bootState = 'BROKEN'
    return bootState
  }
  if (!locked.ok) {
    log.warn(`图库数据被进程 ${locked.holder.pid}（${locked.holder.exe}）占用`)
    bootState = 'LOCKED'
    return bootState
  }
  try {
    await openDatabase(location.pgdata, location.migrationsFolder)
    bootState = 'READY'
    log.info('数据库已打开')
  } catch (err) {
    log.error('打开或迁移数据库失败', err)
    releaseDbLock(location.lockFile)
    bootState = 'BROKEN'
  }
  return bootState
}

// 关闭数据库并释放锁，退出前调用
export async function shutdownDatabase(lockFile: string): Promise<void> {
  try {
    await closeDatabase()
  } finally {
    releaseDbLock(lockFile)
    bootState = 'NOT_OPENED'
  }
}
