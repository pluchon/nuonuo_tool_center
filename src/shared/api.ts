// 主进程与渲染进程共用的 IPC 契约：统一响应结构、通道名与数据类型
import type { AppSettings, ScanFormat, SortKey } from './settings'

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
  galleryList: 'gallery:list',
  galleryDetail: 'gallery:detail',
  fileShowInFolder: 'file:showInFolder',
  fileOpen: 'file:open',
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

// 图库视图：全部图片（打过标签的）/ 还没打标签 / 最近导入 / R-18 图 / 某个源目录 / 某个类目录
export type GalleryViewKey = 'all' | 'untagged' | 'recent' | 'r18' | 'source' | 'category'

// 网格查询条件
export interface GalleryQueryDTO {
  view: GalleryViewKey
  // view = source 时的源目录 id
  sourceId?: number
  // view = category 时的顶层类目录名
  category?: string
  // 按图片名（全部图片、R-18、类目录里还按标签名）搜索
  q?: string
  sort: SortKey
  // 只看 R-18（全部图片、类目录）
  onlyR18?: boolean
  // 只看当前目录，不含子目录（源目录、类目录）
  onlyHere?: boolean
}

// 缩略图状态：已生成 / 还没生成 / 生成失败（无法预览）
export type ThumbState = 'READY' | 'PENDING' | 'FAILED'

// 网格里的一张图（同一内容在当前视图里有多个位置也只出一张）
export interface GalleryItemVO {
  imageId: number
  // 代表这张图的文件位置（优先正常、目录在线的那个）
  fileId: number
  name: string
  format: ScanFormat
  width: number | null
  height: number | null
  byteSize: number
  // 缩略图文件名用的内容哈希
  hash: string
  thumb: ThumbState
  // 文件不见了 / 所在源目录找不到
  missing: boolean
  offline: boolean
  isR18: boolean
  tagged: boolean
  importedAt: string
  takenAt: string | null
}

// 网格数据：已经按条件过滤、按排序排好
export interface GalleryListVO {
  items: GalleryItemVO[]
}

// 一张图在磁盘上的一个位置
export interface ImageLocationVO {
  fileId: number
  path: string
  missing: boolean
  offline: boolean
}

// 详情面板：一张图的完整信息
export interface ImageDetailVO {
  imageId: number
  name: string
  format: ScanFormat
  width: number | null
  height: number | null
  byteSize: number
  hash: string
  thumb: ThumbState
  isR18: boolean
  importedAt: string
  takenAt: string | null
  exif: ExifInfoVO | null
  locations: ImageLocationVO[]
}

// 拍摄信息（没有的项不出现）
export interface ExifInfoVO {
  make?: string
  model?: string
  lens?: string
  // 焦距（毫米）
  focalLength?: number
  // 光圈 f 值
  fNumber?: number
  // 快门（秒）
  exposureTime?: number
  iso?: number
}

export type { AppSettings }
