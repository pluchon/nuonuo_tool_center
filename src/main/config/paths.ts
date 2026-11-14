import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

// 应用数据目录下的派生数据位置（数据库、缩略图、模型），不放在用户图片目录里
export interface DataPaths {
  root: string
  pgdata: string
  thumbs: string
  models: string
}

// 取得数据目录并确保其存在
export function resolveDataPaths(): DataPaths {
  const root = app.getPath('userData')
  const paths: DataPaths = {
    root,
    pgdata: join(root, 'pgdata'),
    thumbs: join(root, 'thumbs'),
    models: join(root, 'models')
  }
  for (const dir of [paths.thumbs, paths.models]) {
    mkdirSync(dir, { recursive: true })
  }
  return paths
}
