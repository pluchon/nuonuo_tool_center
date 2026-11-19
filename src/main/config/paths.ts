import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

// 老版本的数据目录名：改过 productName 后 Electron 默认的 userData 会跟着变，这里固定住，老数据才不会“消失”
export const LEGACY_DATA_DIR_NAME = 'LocalToolManage'

// 类目录默认存放的图库文件夹
export const DEFAULT_CATEGORY_HOME = 'D:\\诺诺图床'

// 应用数据目录下的派生数据位置（数据库、缩略图、模型、日志），不放在用户图片目录里
export interface DataPaths {
  root: string
  pgdata: string
  thumbs: string
  models: string
  logs: string
  // 自定义背景图
  backgrounds: string
  lockFile: string
  // 环境变量指定的类目录位置；为空时由设置或默认值决定
  categoryHomeOverride: string | null
}

// 数据目录：设了 LTM_DATA_DIR 就用它（开发和测试隔离），否则固定为 %APPDATA%\LocalToolManage
export function resolveDataRoot(env: NodeJS.ProcessEnv, appDataDir: string): string {
  const fromEnv = env.LTM_DATA_DIR?.trim()
  return fromEnv ? resolve(fromEnv) : join(appDataDir, LEGACY_DATA_DIR_NAME)
}

// 环境变量指定的类目录位置
export function resolveCategoryHomeOverride(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.LTM_CATEGORY_HOME?.trim()
  return fromEnv ? resolve(fromEnv) : null
}

// 生效的类目录位置：环境变量 > 设置 > 默认值
export function effectiveCategoryHome(override: string | null, fromSetting: string | null): string {
  return override ?? fromSetting ?? DEFAULT_CATEGORY_HOME
}

// 由数据目录推出各子目录，并确保存在（pgdata 交给 PGlite 自己建）
export function buildDataPaths(root: string, env: NodeJS.ProcessEnv): DataPaths {
  const paths: DataPaths = {
    root,
    pgdata: join(root, 'pgdata'),
    thumbs: join(root, 'thumbs'),
    models: join(root, 'models'),
    logs: join(root, 'logs'),
    backgrounds: join(root, 'backgrounds'),
    lockFile: join(root, 'ltm.lock'),
    categoryHomeOverride: resolveCategoryHomeOverride(env)
  }
  for (const dir of [paths.root, paths.thumbs, paths.models, paths.logs]) {
    mkdirSync(dir, { recursive: true })
  }
  return paths
}
