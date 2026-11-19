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
  libraryRelocateRoot: 'library:relocateRoot',
  libraryListFolders: 'library:listFolders',
  scanStart: 'scan:start',
  scanStop: 'scan:stop',
  scanGetState: 'scan:getState',
  windowSetTheme: 'window:setTheme',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close'
} as const

// 主进程主动推给渲染进程的事件
export const IpcEvent = {
  // 扫描状态变化：开始、进度、结束都推同一个结构
  scanState: 'scan:state'
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
  // 目录找不到（移动硬盘没接、文件夹被移走）
  offline: boolean
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
  // 最近一次扫描完成的时间（ISO），还没扫描过为空
  lastScanAt: string | null
}

// 导入对话框里的一个文件夹（盘符或某一层子文件夹）
export interface FolderNodeVO {
  path: string
  // 显示名：盘符显示成“D: 盘”，其余是文件夹名
  label: string
  isDrive: boolean
  hasChildren: boolean
  // 不能选的原因：图库文件夹 / 已导入 / 含已导入；能选时为空
  lock: 'LIBRARY' | 'IMPORTED' | 'HOLDS' | null
}

// 扫描进度：正在扫描时有值
export interface ScanProgressVO {
  // 只扫一个源目录时是它的名字；扫描全部时为空
  rootName: string | null
  rootIds: number[]
  done: number
  total: number
  found: number
}

// 一次扫描的结果：用来弹完成提示、更新底栏
export interface ScanResultVO {
  rootName: string | null
  total: number
  found: number
  stopped: boolean
  // 读失败的文件数（被占用、没权限），这些文件保持原来的状态
  failed: number
  // 启动时自动发起的扫描：完成时不弹提示（有读失败的除外）
  auto: boolean
  finishedAt: string
}

// 扫描状态：正在扫描时 progress 有值；last 是上一次扫描的结果
export interface ScanStateVO {
  progress: ScanProgressVO | null
  last: ScanResultVO | null
}

// 已导入的图库目录
export interface LibraryRootVO {
  id: number
  name: string
  path: string
  createTime: string
}

export type { AppSettings }
