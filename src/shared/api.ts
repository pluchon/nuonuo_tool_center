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
  settingsPickCategoryHome: 'settings:pickCategoryHome',
  settingsPickBackground: 'settings:pickBackground',
  systemDataInfo: 'system:dataInfo',
  systemOpenDataDir: 'system:openDataDir',
  systemCleanCache: 'system:cleanCache',
  systemExportBackup: 'system:exportBackup',
  systemPickFolder: 'system:pickFolder',
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
  galleryUntaggedDirs: 'gallery:untaggedDirs',
  tagCatalog: 'tag:catalog',
  imageRename: 'image:rename',
  imageSetR18: 'image:setR18',
  imageAddTag: 'image:addTag',
  imageRemoveTag: 'image:removeTag',
  imageCommonTags: 'image:commonTags',
  tagCreate: 'tag:create',
  tagSave: 'tag:save',
  tagDelete: 'tag:delete',
  tagCategoryCreate: 'tagCategory:create',
  tagCategoryRename: 'tagCategory:rename',
  tagCategorySetColor: 'tagCategory:setColor',
  tagCategoryDelete: 'tagCategory:delete',
  fileDelete: 'file:delete',
  fileUndoDelete: 'file:undoDelete',
  fileTransferRoots: 'file:transferRoots',
  fileMove: 'file:move',
  fileCopy: 'file:copy',
  fileUndoTransfer: 'file:undoTransfer',
  libraryDirChildren: 'library:dirChildren',
  folderCreate: 'folder:create',
  folderRename: 'folder:rename',
  folderDelete: 'folder:delete',
  folderOpen: 'folder:open',
  sourceRemove: 'source:remove',
  fileCopyImage: 'file:copyImage',
  aiStatus: 'ai:status',
  aiIdeas: 'ai:ideas',
  aiConversations: 'ai:conversations',
  aiMessages: 'ai:messages',
  aiAsk: 'ai:ask',
  aiAnswer: 'ai:answer',
  aiRename: 'ai:rename',
  aiPin: 'ai:pin',
  aiDelete: 'ai:delete',
  aiUndoDelete: 'ai:undoDelete',
  aiVote: 'ai:vote',
  windowSetTheme: 'window:setTheme',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close'
} as const

// 设置里“数据与缓存”“关于”要的信息
export interface DataInfoVO {
  dataDir: string
  // 缩略图缓存的总大小（字节）
  cacheBytes: number
  version: string
  // 类目录现在的位置；由环境变量指定时不能在设置里改
  categoryHome: string
  categoryHomeLocked: boolean
}

// 清理缩略图缓存的结果
export interface CacheCleanVO {
  removed: number
  freedBytes: number
}

// 主进程主动推给渲染进程的事件
export const IpcEvent = {
  // 扫描状态变化：开始、进度、结束都推同一个结构
  scanState: 'scan:state',
  // 一批文件操作真正执行完（删除进回收站之后），带上失败的数量和原因
  fileOpDone: 'fileOp:done'
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

// 侧栏目录树里的一个目录：源目录（按 id + 子路径）或类目录（相对图库文件夹的路径；空串表示图库文件夹本身）
export type FolderRefDTO = { kind: 'source'; id: number; sub: string } | { kind: 'category'; path: string }

// 侧栏目录树展开后的一个子目录
export interface DirNodeVO {
  name: string
  // 相对所属根目录的路径（源目录相对源目录，类目录相对图库文件夹）
  rel: string
  count: number
  hasChildren: boolean
}

// 目录名最多几个字（和图片名一样）
export const DIR_NAME_MAX = 15

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
  // view = source 时的子文件夹（相对源目录，用反斜杠分隔；空表示整个源目录）
  sub?: string
  // view = category 时的类目录（相对图库文件夹的路径，可以带子目录，用反斜杠分隔）
  category?: string
  // 按图片名（全部图片、R-18、类目录里还按标签名）搜索
  q?: string
  sort: SortKey
  // 只看 R-18（全部图片、类目录）
  onlyR18?: boolean
  // 只看当前目录，不含子目录（源目录、类目录）
  onlyHere?: boolean
  // 带其中任一标签（全部图片、R-18 图、类目录；最多 5 个）
  tagIds?: number[]
  // 在其中任一目录里（全部图片、R-18 图、还没打标签；最多 5 个；选父目录包含子目录）
  dirs?: DirKeyDTO[]
  // 更多筛选：同一组内是“或”，不同组之间是“与”
  more?: MoreFilterDTO
}

// 筛选用的目录：源目录按 id，类目录按顶层文件夹名
export type DirKeyDTO = { kind: 'source'; id: number } | { kind: 'category'; name: string }

// 更多筛选的选项
export interface MoreFilterDTO {
  fmt?: ScanFormat[]
  // 横图 / 竖图 / 方图
  ori?: Array<'h' | 'v' | 'sq'>
  // 4K 及以上 / 1080p 及以上 / 1000px 以下（按长边）
  res?: Array<'4k' | 'fhd' | 'small'>
  // 1 MB 以下 / 1–10 MB / 10 MB 以上
  size?: Array<'s' | 'm' | 'l'>
  // 近 30 天 / 今年 / 去年 / 没有拍摄时间
  date?: Array<'30d' | 'y' | 'ly' | 'none'>
}

// “还没打标签”里的目录筛选项：含未打标签图的目录（源目录和顶层类目录）
export interface DirCountVO {
  dir: DirKeyDTO
  label: string
  count: number
}

// 标签分类
export interface TagCategoryVO {
  id: number
  name: string
  // 12 色调色板的序号
  colorIndex: number
  sortOrder: number
}

// 标签字典里的一个标签：名字、分类、别名、用在多少张图上
export interface TagVO {
  id: number
  name: string
  categoryId: number
  aliases: string[]
  count: number
}

// 全部标签和分类（加标签的候选、筛选下拉都用它）
export interface TagCatalogVO {
  categories: TagCategoryVO[]
  tags: TagVO[]
}

// 一张图上的标签
export interface ImageTagVO {
  id: number
  name: string
  categoryId: number
}

// 给一张或多张图加标签：按名字和别名匹配已有标签，没有就在 categoryId 分类下新建
export interface AddTagDTO {
  imageIds: number[]
  name: string
  categoryId?: number
}

// 加标签的结果：实际加上的张数、已经有的张数、已满 5 个跳过的张数
export interface AddTagResultVO {
  tag: ImageTagVO
  added: number
  already: number
  skipped: number
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
  // 用户起的名字（没起过为空，显示时用文件名）
  displayName: string | null
  tags: ImageTagVO[]
  locations: ImageLocationVO[]
}

// 名字最多几个字、每张图最多几个标签、筛选最多选几个
export const NAME_MAX = 15
export const TAGS_PER_IMAGE = 5
export const FILTER_MAX = 5
// 标签名、别名最多几个字（照原型标签管理页的 15 字计数）
export const TAG_NAME_MAX = 15
// 分类名最多几个字
export const CATEGORY_NAME_MAX = 6
// 一次最多把几个标签合并进来
export const MERGE_MAX = 5

// 删除的结果：批次 id（撤销用）、删了几张图、因为目录找不到没删的位置数
export interface DeleteResultVO {
  batchId: number
  images: number
  skipped: number
}

// 移动 / 复制对话框里一个可以作为目标的文件夹
export interface TransferFolderVO {
  path: string
  label: string
  hasChildren: boolean
}

// 移动 / 复制对话框的两组顶层：源目录（带 id，数量从侧栏取）、类目录（图库文件夹下的顶层文件夹）
export interface TransferRootsVO {
  sources: Array<TransferFolderVO & { id: number; offline: boolean }>
  categories: TransferFolderVO[]
  // 类目录所在的图库文件夹（判断“其他位置”选的文件夹在不在图库里）
  home: string
}

// 移动 / 复制的结果：批次 id（撤销用）、做成几步、跳过几步（已经在那里）、失败几步和第一个原因
export interface TransferResultVO {
  batchId: number | null
  done: number
  skipped: number
  failed: number
  error: string | null
}

// 一批文件操作执行完：成功几步、失败几步、第一个失败原因
export interface FileOpDoneVO {
  batchId: number
  done: number
  failed: number
  error: string | null
}

// 新建标签：名字、分类、别名
export interface CreateTagDTO {
  name: string
  categoryId: number
  aliases: string[]
}

// 保存标签管理右侧面板：改名、换分类、别名整组替换，可同时合并
// mergeInto：把这个标签并入另一个标签（这个标签消失）；mergeFrom：把别的标签合并进来（最多 5 个）
export interface SaveTagDTO {
  id: number
  name: string
  categoryId: number
  aliases: string[]
  mergeInto?: number | null
  mergeFrom?: number[]
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

// 诺诺助手：能不能用（没配 DASHSCOPE_API_KEY 时整页显示“诺诺还没连上云端”）
export interface AiStatusVO {
  ready: boolean
}

// 对话记录里的一段对话
export interface AiConversationVO {
  id: number
  title: string
  pinned: boolean
  // 最后一次说话的时间（ISO）
  updatedAt: string
}

// 对话里的一条消息：你说的话，或诺诺的回复
export interface AiMessageVO {
  id: number
  role: 'user' | 'assistant'
  text: string
  // 回复上方的一行灰字：这次怎么找的（如“搜索了图库：标签「猫」，找到 3 张”）；没有检索时为空
  how: string | null
  // 结果图（按回复时的顺序；已经删掉的图不再出现）
  images: GalleryItemVO[]
  vote: 'UP' | 'DOWN' | null
  createdAt: string
}

// 问诺诺：conversationId 为空时新开一段对话；scope 为空表示全部图库
export interface AiAskDTO {
  conversationId: number | null
  text: string
  scope: DirKeyDTO | null
  includeR18: boolean
}

// 问完先返回：对话（新开的也有 id 了）和刚存下的这句话，回复另外取
export interface AiAskResultVO {
  conversation: AiConversationVO
  message: AiMessageVO
}

// 一句话最多几个字、对话名最多几个字
export const AI_TEXT_MAX = 500
export const AI_TITLE_MAX = 30

export type { AppSettings }
