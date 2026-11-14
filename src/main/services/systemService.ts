import { app } from 'electron'
import type { SystemInfoVO } from '@shared/api'
import { readCloudCredentials } from '../config/cloudConfig'
import { getDatabase } from '../db/client'

// 汇总系统信息；凭证只报告是否存在，绝不返回内容
export async function getSystemInfo(dataDir: string): Promise<SystemInfoVO> {
  const { pg } = getDatabase()
  const versionResult = await pg.query<{ version: string }>('SELECT version() AS version')
  const extResult = await pg.query<{ extname: string }>('SELECT extname FROM pg_extension ORDER BY extname')
  const credentials = readCloudCredentials()
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    dataDir,
    database: {
      ready: true,
      postgresVersion: versionResult.rows[0]?.version ?? '',
      extensions: extResult.rows.map((r) => r.extname)
    },
    credentials: {
      dashscope: Boolean(credentials.dashscopeApiKey),
      aliyunAccessKey: Boolean(credentials.aliyunAccessKeyId && credentials.aliyunAccessKeySecret)
    }
  }
}
