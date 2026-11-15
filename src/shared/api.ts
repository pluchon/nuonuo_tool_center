// 主进程与渲染进程共用的 IPC 契约：统一响应结构、通道名与数据类型

// 统一响应：成功带 data，失败带错误码与可展示的信息
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; message: string }

// 错误码：区分参数错误、业务冲突、外部依赖失败与未知错误
export type ApiErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'CANCELLED' | 'DEPENDENCY_FAILED' | 'INTERNAL'

// IPC 通道名，按领域分组
export const IpcChannel = {
  systemGetInfo: 'system:getInfo',
  libraryListRoots: 'library:listRoots',
  libraryAddRoot: 'library:addRoot',
  windowSetTheme: 'window:setTheme'
} as const

// 界面主题：雨天午后（浅色）/ 夜雨灯笼（深色）
export type ThemeMode = 'light' | 'dark'

// 系统信息：版本、数据目录、数据库状态与凭证是否就绪（只给布尔值，不给内容）
export interface SystemInfoVO {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  dataDir: string
  database: { ready: boolean; postgresVersion: string; extensions: string[] }
  credentials: { dashscope: boolean; aliyunAccessKey: boolean }
}

// 已导入的图库目录
export interface LibraryRootVO {
  id: number
  name: string
  path: string
  createTime: string
}
