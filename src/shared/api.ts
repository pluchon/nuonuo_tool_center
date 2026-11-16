// 主进程与渲染进程共用的 IPC 契约：统一响应结构、通道名与数据类型
import type { AppSettings } from './settings'

// 统一响应：成功带 data，失败带错误码与可展示的信息
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; message: string }

// 错误码：区分参数错误、业务冲突、外部依赖失败与未知错误
export type ApiErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'CANCELLED' | 'DEPENDENCY_FAILED' | 'INTERNAL'

// IPC 通道名，按领域分组
export const IpcChannel = {
  systemGetBootState: 'system:getBootState',
  systemRetryDatabase: 'system:retryDatabase',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  libraryGetOverview: 'library:getOverview',
  libraryAddRoot: 'library:addRoot',
  windowSetTheme: 'window:setTheme',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close'
} as const

// 实际生效的明暗（“跟随系统”已经解析过）
export type ThemeMode = 'light' | 'dark'

// 图库数据库状态：还没打开 / 正常 / 被另一个进程占用 / 打不开（损坏或迁移失败）
export type DbBootState = 'NOT_OPENED' | 'READY' | 'LOCKED' | 'BROKEN'

// 侧栏计数：全部图片（打过标签的）、还没打标签、最近导入、R-18、标签数，以及底栏的图片总数
export interface SidebarCountsVO {
  total: number
  tagged: number
  untagged: number
  recent: number
  r18: number
  tags: number
}

// 侧栏里的一个源目录
export interface SourceRootVO {
  id: number
  name: string
  path: string
  count: number
  // 磁盘上有子文件夹：图标用多文件夹，可以展开
  hasChildren: boolean
}

// 侧栏里的一个顶层类目录
export interface CategoryDirVO {
  name: string
  count: number
  hasChildren: boolean
}

// 侧栏和底栏需要的全部数据
export interface LibraryOverviewVO {
  counts: SidebarCountsVO
  sources: SourceRootVO[]
  categories: CategoryDirVO[]
}

// 已导入的图库目录
export interface LibraryRootVO {
  id: number
  name: string
  path: string
  createTime: string
}

export type { AppSettings }
