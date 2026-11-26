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
  settingsGetAiCredentials: 'settings:getAiCredentials',
  settingsSaveAiCredentials: 'settings:saveAiCredentials',
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
  fileStartDrag: 'file:startDrag',
  aiStatus: 'ai:status',
  aiIdeas: 'ai:ideas',
  aiPredict: 'ai:predict',
  aiConversations: 'ai:conversations',
  aiMessages: 'ai:messages',
  aiAsk: 'ai:ask',
  aiAttachmentOriginal: 'ai:attachmentOriginal',
  aiEditMessage: 'ai:editMessage',
  aiRecallMessage: 'ai:recallMessage',
  aiRecalledDraft: 'ai:recalledDraft',
  aiAnswer: 'ai:answer',
  aiAbort: 'ai:abort',
  aiCompact: 'ai:compact',
  aiPolicy: 'ai:policy',
  aiReferencePreviews: 'ai:referencePreviews',
  aiEmbeddingLimit: 'ai:embeddingLimit',
  aiResetRules: 'ai:resetRules',
  aiPreference: 'ai:preference',
  categoryProposal: 'ai:categoryProposal',
  categoryProposalDecide: 'ai:categoryProposalDecide',
  aiRename: 'ai:rename',
  aiPin: 'ai:pin',
  aiDelete: 'ai:delete',
  aiUndoDelete: 'ai:undoDelete',
  aiVote: 'ai:vote',
  lookState: 'look:state',
  lookRetry: 'look:retry',
  lookNow: 'look:now',
  lookCancelAll: 'look:cancelAll',
  lookRefreshSuggestion: 'look:refreshSuggestion',
  lookRefreshStatus: 'look:refreshStatus',
  suggestionList: 'suggestion:list',
  suggestionDecide: 'suggestion:decide',
  suggestionAcceptAll: 'suggestion:acceptAll',
  assistPrompt: 'assist:prompt',
  assistImport: 'assist:import',
  suggestionDecideMany: 'suggestion:decideMany',
  ratingProgress: 'rating:progress',
  organizeState: 'organize:state',
  organizeEstimate: 'organize:estimate',
  organizeDismissEstimate: 'organize:dismissEstimate',
  organizeStart: 'organize:start',
  organizeApprove: 'organize:approve',
  organizeCancel: 'organize:cancel',
  reorganizeEstimate: 'reorganize:estimate',
  reorganizeDismissEstimate: 'reorganize:dismissEstimate',
  reorganizeResetToSource: 'reorganize:resetToSource',
  reorganizeRelook: 'reorganize:relook',
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
}

// 清理缩略图缓存的结果
export interface CacheCleanVO {
  removed: number
  freedBytes: number
}

// 主进程主动推给渲染进程的事件
export const IpcEvent = {
  aiCompaction: 'ai:compaction',
  aiStream: 'ai:stream',
  // 扫描状态变化：开始、进度、结束都推同一个结构
  scanState: 'scan:state',
  // 一批文件操作真正执行完（删除进回收站之后），带上失败的数量和原因
  fileOpDone: 'fileOp:done',
  // 本地分级把一些图判成了 R-18（带张数）：界面刷新计数和网格
  ratingR18: 'rating:r18',
  // 看图队列变了（带完整状态）
  lookState: 'look:state',
  // 有新的 AI 建议：界面刷新“AI 建议”计数
  aiSuggested: 'ai:suggested',
  // 本地分级的进度
  ratingProgress: 'rating:progress',
  // 一键整理的状态变了
  organizeState: 'organize:state'
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
  // 有待确认 AI 建议的图
  aiSuggest: number
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
  // 本次首次登记的文件位置数；恢复同一任务后沿用原来的计数基准。
  added: number
  stopped: boolean
  // 读失败的文件数（被占用、没权限），这些文件保持原来的状态
  failed: number
  unreadableDirs: number
  error?: string
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

// 图库视图：全部图片（打过标签的）/ 还没打标签 / 最近导入 / R-18 图 / AI 建议 / 某个源目录 / 某个类目录
export type GalleryViewKey = 'all' | 'untagged' | 'recent' | 'r18' | 'ai' | 'source' | 'category'

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

// 加标签的结果：实际加上、已有该标签，以及因标签已满而跳过的图片数。
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
  // 只在“AI 建议”视图里：建议放进的类目录（没有这类建议时为空）
  aiDir?: { name: string; isNew: boolean } | null
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
export interface ImageDetailVO extends GalleryItemVO {
  // R-18 是本地模型判的（你还没手动开关过）：详情的 R-18 一行标“诺诺判的”
  r18ByModel: boolean
  exif: ExifInfoVO | null
  // 用户起的名字（没起过为空，显示时用文件名）
  displayName: string | null
  tags: ImageTagVO[]
  locations: ImageLocationVO[]
}

// 名字最多几个字、每张图最多几个标签、筛选最多选几个
export const NAME_MAX = 15
export const TAGS_PER_IMAGE = 15
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

// 诺诺助手：是否配置了百炼 API Key
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

// 图片保留原文件类型，发送后的 dataUrl 为缩小的预览图。剪贴板图片可以没有文件名。
export type AiAttachment =
  | { kind: 'image'; name: string; mimeType: string; dataUrl: string }
  | { kind: 'markdown'; name: string; text: string }

export const AI_MARKDOWN_MAX_BYTES = 64 * 1024

export interface AiImageReference {
  imageId: number
  name: string
  groupId: string
  position: number
  sourceMessageId?: number
}
export interface AiReferencePreview {
  imageId: number
  hash: string
  isR18: boolean
}
export const AI_CONTEXT_WINDOW = 475_000

// 单次对话请求占用的上下文，含输入、生成内容和已命中的缓存前缀。
export interface AiContextUsage {
  usedTokens: number
  estimated: boolean
  compacted?: boolean
}

export interface AiCompactResult {
  changed: boolean
  checkpoint: { messageId: number; usage: AiContextUsage } | null
}

export type AiTimelineBlock =
  | { type: 'action'; id: string; tool: string; summary: string; status: 'running' | 'done' | 'failed' | 'aborted' }
  | { type: 'narration'; text: string }

export interface AiStreamEvent {
  conversationId: number
  kind:
    | 'status'
    | 'delta'
    | 'narration_commit'
    | 'action_start'
    | 'action_end'
    | 'memory_notice'
    | 'reset'
    | 'done'
    | 'error'
    | 'aborted'
  text?: string
  tool?: string
  actionId?: string
  summary?: string
  status?: 'running' | 'done' | 'failed' | 'aborted'
  block?: AiTimelineBlock
  memoryNotice?: AiMemoryNotice
}

export interface AiPolicyVO {
  pendingImages: number
  confirmedFolders: number
  dailyLimit: number
  dailyUsed: number
  localHits: number
  cloudCachedTokens: number
  preferences: Array<{ id: number; content: string; explicit: boolean }>
}

// 百炼为本条回复的各次对话请求实际报告的输入量与缓存命中量。
export interface AiReplyCacheUsage {
  inputTokens: number
  cachedTokens: number
}

// 本轮记住/更新/遗忘偏好时，附带给用户看的轻量提示。
export interface AiMemoryNotice {
  action?: 'save' | 'update' | 'forget'
  notices: string[]
}

// 对话里的一条消息：你说的话，或诺诺的回复
export interface AiMessageVO {
  scope?: DirKeyDTO | null
  includeR18?: boolean
  canPredict?: boolean
  references?: AiImageReference[]
  categoryProposalId?: number
  proposalNote?: true
  memoryNotice?: AiMemoryNotice
  blocks?: AiTimelineBlock[]
  interrupted?: boolean
  id: number
  role: 'user' | 'assistant'
  text: string
  contextUsage?: AiContextUsage
  cacheUsage?: AiReplyCacheUsage
  // 回复上方的一行灰字：这次怎么找的（如“搜索了图库：标签「猫」，找到 3 张”）；没有检索时为空
  how: string | null
  // 结果图（按回复时的顺序；已经删掉的图不再出现）
  images: GalleryItemVO[]
  // 原回复是否保存过结果，用于复核或分级变化后重新读取可显示的卡片。
  hasStoredResults?: boolean
  vote: 'UP' | 'DOWN' | null
  createdAt: string
  // 你发的图（按图找相似时，长边 512 的 data URL）；没有为空
  image: string | null
  attachments?: AiAttachment[]
  attachment?: AiAttachment | null
}

export interface CategoryProposalVO {
  filingPreview?: { hashes: Array<string | null>; total: number }
  id: number
  status: 'pending' | 'applied' | 'cancelled'
  started: boolean
  analysisCount: number
  scope: string | null
  entries: Array<{
    kind: 'create' | 'existing' | 'move' | 'copy'
    path: string
    from?: string
    count?: number
    tag?: string
  }>
}

export type AiSearchScope = Extract<DirKeyDTO, { kind: 'category' }>

export interface AiPredictionDTO {
  selectionCount?: number
  references?: AiImageReference[]
  conversationId: number
  replyId: number
  scope: AiSearchScope | null
  includeR18: boolean
}

export interface AiRecalledDraft {
  references?: AiImageReference[]
  messageId: number
  text: string
  scope: AiSearchScope | null
  includeR18: boolean
  attachments: AiAttachment[]
}

// 问诺诺：conversationId 为空时新开一段对话，scope 为空时搜索全部类目录。
export interface AiAskDTO {
  references?: AiImageReference[]
  conversationId: number | null
  recalledMessageId?: number
  text: string
  scope: AiSearchScope | null
  includeR18: boolean
  // 同一条消息可以同时携带一张图片和一份 Markdown。
  attachments?: AiAttachment[]
  attachment?: AiAttachment
  // 兼容原先直接传入图片 data URL 的调用。
  image?: string
}

// 上传的图最大多少（base64 字符数，约 20 MB 的图）
export const AI_IMAGE_MAX_BASE64 = 28_000_000

// 问完先返回：对话（新开的也有 id 了）和刚存下的这句话，回复另外取
export interface AiAskResultVO {
  conversation: AiConversationVO
  message: AiMessageVO
}

// 看图队列里的一张：实时看图、批量处理、等待中或出错
export interface LookRowVO {
  jobId: number
  imageId: number
  name: string
  hash: string
  state: 'RUNNING' | 'BATCH' | 'QUEUED' | 'FAILED'
  error: string | null
}

// 看图队列：总数（含出错的）和前面若干行
export interface LookStateVO {
  count: number
  activity: 'idle' | 'queued' | 'working'
  rows: LookRowVO[]
  canCancel: boolean
  needsApiKey: boolean
  reorganizing: boolean
  activeImageIds: number[]
}

export const SUGGESTION_REFRESH_DEEP_AT = 3
export const SUGGESTION_REFRESH_MAX = 5

export interface SuggestionRefreshStatusVO {
  refreshCount: number
  maxRefreshes: number
  active: boolean
}

export const LOOK_KEY_HINT = '请在「设置 → AI」中配置百炼 API Key'

// 一项待确认的 AI 建议
export interface AiSuggestionVO {
  // 名字、角色、作品、出处、标签、放进类目录和 R-18 分级复核
  key: string
  kind: 'name' | 'tag' | 'who' | 'work' | 'src' | 'dir' | 'r18Review'
  value: string
  // 诺诺看图给的，还是外部 AI 贴回来的
  origin: 'NONO' | 'EXTERNAL'
  // 放进类目录时：目录现在还不存在，采用时新建
  isNew?: boolean
}

// 多张图的建议一起采用或不要的结果
export interface SuggestionBatchVO {
  // 处理完的图片数、有没处理成的图片数和第一个原因
  done: number
  failed: number
  error: string | null
}

// 本地分级的进度：这一轮已判多少、一共要判多少
export interface RatingProgressVO {
  running: boolean
  done: number
  total: number
}

// 一键整理方案里的一个类目录：收哪些角色、作品、标签
export interface OrganizeFolderVO {
  name: string
  isNew: boolean
  characters: string[]
  works: string[]
  tags: string[]
}

// 一键整理的阶段：空闲、看图中、出方案中、方案待确认、分图中、方案已批后陆续补图（本地分级后判完的老图按半价看完再按方案分）
export type OrganizePhase = 'IDLE' | 'LOOKING' | 'PLANNING' | 'PLAN_READY' | 'ASSIGNING' | 'FOLLOWING'

// 整理正在使用看图队列时，避免从队列弹窗取消整理需要的图片。
export function organizeUsesLookQueue(phase: OrganizePhase): boolean {
  return phase === 'LOOKING' || phase === 'FOLLOWING'
}

// 一键整理的状态
export interface OrganizeStateVO {
  phase: OrganizePhase
  plan: OrganizeFolderVO[] | null
  // 出方案失败的原因（可以重试）
  error: string | null
  // 看图阶段的进度（只在看图中有）
  looked?: OrganizeLookedVO | null
}

// 一键整理看图进度：这次要看的图看完了几张
export interface OrganizeLookedVO {
  done: number
  total: number
}

// 开始前的估算：要看多少张、大概多少 token 和钱（以账单为准）
export interface OrganizeEstimateVO {
  toLook: number
  tokens: number
  yuan: number
  // 本地分级还剩多少张没判；全部判完后才能开始整理。
  ratingLeft: number
}

// 重新整理：开始前的估算（已整理总数，以及若选择“重新 AI 整理”要重看多少张、大概多少 token 和钱）
export interface ReorganizeEstimateVO {
  organizedCount: number
  toLook: number
  tokens: number
  yuan: number
  ratingLeft: number
  pendingSuggestionCount?: number
  blockedByRatingCount?: number
  inQueueCount?: number
}

export type ApiKind = 'chat' | 'compact' | 'look' | 'dream' | 'translate' | 'identify' | 'embed' | 'organize' | 'predict'

export const API_KIND_META: Record<ApiKind, { label: string }> = {
  chat: { label: '助手对话' },
  look: { label: '诺诺看图' },
  organize: { label: '一键整理' },
  embed: { label: '画面向量' },
  compact: { label: '对话精简' },
  dream: { label: '空闲做梦' },
  translate: { label: '词表翻译' },
  identify: { label: '以图找图' },
  predict: { label: '指令联想' }
}

// 重新整理“归回源目录”的结果
export interface ReorganizeResetResultVO {
  resetImages: number
  removedCopies: number
  movedToSource: number
  skippedOnlyInCategory: number
}

// 重新整理“重新 AI 整理”的入队结果
export interface ReorganizeRelookResultVO {
  enqueued: number
}

// 批好的方案最多几个目录、每个目录最多几个词
export const ORGANIZE_FOLDERS_MAX = 20
export const ORGANIZE_TERMS_MAX = 20

// 一句话最多几个字、对话名最多几个字
export const AI_TEXT_MAX = 500
export const AI_TITLE_MAX = 30

export type { AppSettings }
