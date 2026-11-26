import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  IpcEvent,
  type OrganizeEstimateVO,
  type OrganizeFolderVO,
  type OrganizeStateVO,
  type ReorganizeEstimateVO,
  type ReorganizeRelookResultVO,
  type ReorganizeResetResultVO,
  type RatingProgressVO,
  type SuggestionBatchVO,
  type AddTagDTO,
  type AddTagResultVO,
  type ApiResponse,
  type CategoryProposalVO,
  type AiPolicyVO,
  type AiCompactResult,
  type AiReferencePreview,
  type AppSettings,
  type DbBootState,
  type FolderNodeVO,
  type GalleryListVO,
  type GalleryQueryDTO,
  type ImageDetailVO,
  type ImageTagVO,
  type LibraryOverviewVO,
  type LibraryRootVO,
  type ScanStateVO,
  type TagCatalogVO,
  type TagCategoryVO,
  type CreateTagDTO,
  type DeleteResultVO,
  type FileOpDoneVO,
  type TransferResultVO,
  type DirNodeVO,
  type FolderRefDTO,
  type TransferRootsVO,
  type SaveTagDTO,
  type DirCountVO,
  type ThemeMode,
  type DataInfoVO,
  type CacheCleanVO,
  type AiAskDTO,
  type AiPredictionDTO,
  type AiRecalledDraft,
  type AiAskResultVO,
  type AiConversationVO,
  type AiMessageVO,
  type AiStatusVO,
  type AiStreamEvent,
  type AiSuggestionVO,
  type LookStateVO,
  type SuggestionRefreshStatusVO
} from '@shared/api'
import type { AiCredentialPatch, AiCredentialStatus } from '@shared/settings'

// 暴露给渲染进程的接口：只开放具体方法，不暴露 ipcRenderer 本身
const api = {
  system: {
    getBootState: (): Promise<ApiResponse<DbBootState>> => ipcRenderer.invoke(IpcChannel.systemGetBootState),
    retryDatabase: (): Promise<ApiResponse<DbBootState>> => ipcRenderer.invoke(IpcChannel.systemRetryDatabase),
    dataInfo: (): Promise<ApiResponse<DataInfoVO>> => ipcRenderer.invoke(IpcChannel.systemDataInfo),
    openDataDir: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.systemOpenDataDir),
    cleanCache: (): Promise<ApiResponse<CacheCleanVO>> => ipcRenderer.invoke(IpcChannel.systemCleanCache),
    exportBackup: (): Promise<ApiResponse<string | null>> => ipcRenderer.invoke(IpcChannel.systemExportBackup),
    pickFolder: (title: string): Promise<ApiResponse<string | null>> => ipcRenderer.invoke(IpcChannel.systemPickFolder, title)
  },
  settings: {
    get: (): Promise<ApiResponse<AppSettings>> => ipcRenderer.invoke(IpcChannel.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<ApiResponse<AppSettings>> =>
      ipcRenderer.invoke(IpcChannel.settingsUpdate, patch),
    getAiCredentials: (): Promise<ApiResponse<AiCredentialStatus>> => ipcRenderer.invoke(IpcChannel.settingsGetAiCredentials),
    saveAiCredentials: (patch: AiCredentialPatch): Promise<ApiResponse<AiCredentialStatus>> =>
      ipcRenderer.invoke(IpcChannel.settingsSaveAiCredentials, patch),
    pickBackground: (): Promise<ApiResponse<AppSettings | null>> => ipcRenderer.invoke(IpcChannel.settingsPickBackground)
  },
  library: {
    getOverview: (): Promise<ApiResponse<LibraryOverviewVO>> => ipcRenderer.invoke(IpcChannel.libraryGetOverview),
    addRoot: (path: string): Promise<ApiResponse<LibraryRootVO>> => ipcRenderer.invoke(IpcChannel.libraryAddRoot, path),
    relocateRoot: (id: number, path: string): Promise<ApiResponse<LibraryRootVO>> =>
      ipcRenderer.invoke(IpcChannel.libraryRelocateRoot, id, path),
    listFolders: (parent: string | null): Promise<ApiResponse<FolderNodeVO[]>> =>
      ipcRenderer.invoke(IpcChannel.libraryListFolders, parent)
  },
  gallery: {
    list: (query: GalleryQueryDTO): Promise<ApiResponse<GalleryListVO>> => ipcRenderer.invoke(IpcChannel.galleryList, query),
    detail: (imageId: number): Promise<ApiResponse<ImageDetailVO>> => ipcRenderer.invoke(IpcChannel.galleryDetail, imageId),
    showInFolder: (fileId: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.fileShowInFolder, fileId),
    open: (fileId: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.fileOpen, fileId),
    untaggedDirs: (): Promise<ApiResponse<DirCountVO[]>> => ipcRenderer.invoke(IpcChannel.galleryUntaggedDirs)
  },
  edit: {
    tagCatalog: (): Promise<ApiResponse<TagCatalogVO>> => ipcRenderer.invoke(IpcChannel.tagCatalog),
    rename: (imageId: number, name: string | null): Promise<ApiResponse<string | null>> =>
      ipcRenderer.invoke(IpcChannel.imageRename, imageId, name),
    setR18: (imageIds: number[], value: boolean): Promise<ApiResponse<number>> =>
      ipcRenderer.invoke(IpcChannel.imageSetR18, imageIds, value),
    addTag: (dto: AddTagDTO): Promise<ApiResponse<AddTagResultVO>> => ipcRenderer.invoke(IpcChannel.imageAddTag, dto),
    removeTag: (imageIds: number[], tagId: number): Promise<ApiResponse<number>> =>
      ipcRenderer.invoke(IpcChannel.imageRemoveTag, imageIds, tagId),
    commonTags: (imageIds: number[]): Promise<ApiResponse<ImageTagVO[]>> => ipcRenderer.invoke(IpcChannel.imageCommonTags, imageIds)
  },
  files: {
    // 拖进窗口的文件或文件夹在磁盘上的路径（Electron 新版本里 File 不再带 path）
    pathOf: (file: File): string => webUtils.getPathForFile(file),
    copyImage: (fileId: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.fileCopyImage, fileId),
    // 系统原生拖拽：带出这些文件位置的原图（hash 是跟手小图用的缩略图）
    startDrag: (fileIds: number[], hash: string): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.fileStartDrag, fileIds, hash),
    remove: (query: GalleryQueryDTO, imageIds: number[]): Promise<ApiResponse<DeleteResultVO>> =>
      ipcRenderer.invoke(IpcChannel.fileDelete, query, imageIds),
    undoDelete: (batchId: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.fileUndoDelete, batchId),
    transferRoots: (): Promise<ApiResponse<TransferRootsVO>> => ipcRenderer.invoke(IpcChannel.fileTransferRoots),
    move: (query: GalleryQueryDTO, imageIds: number[], target: string): Promise<ApiResponse<TransferResultVO>> =>
      ipcRenderer.invoke(IpcChannel.fileMove, query, imageIds, target),
    copy: (query: GalleryQueryDTO, imageIds: number[], targets: string[]): Promise<ApiResponse<TransferResultVO>> =>
      ipcRenderer.invoke(IpcChannel.fileCopy, query, imageIds, targets),
    undoTransfer: (batchId: number): Promise<ApiResponse<TransferResultVO>> => ipcRenderer.invoke(IpcChannel.fileUndoTransfer, batchId),
    // 订阅文件操作执行完的通知，返回取消订阅的函数
    onDone: (listener: (result: FileOpDoneVO) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, result: FileOpDoneVO): void => listener(result)
      ipcRenderer.on(IpcEvent.fileOpDone, handler)
      return () => ipcRenderer.removeListener(IpcEvent.fileOpDone, handler)
    }
  },
  folders: {
    children: (ref: FolderRefDTO): Promise<ApiResponse<DirNodeVO[]>> => ipcRenderer.invoke(IpcChannel.libraryDirChildren, ref),
    create: (parent: FolderRefDTO, name: string | null): Promise<ApiResponse<string>> => ipcRenderer.invoke(IpcChannel.folderCreate, parent, name),
    rename: (ref: FolderRefDTO, name: string): Promise<ApiResponse<string>> => ipcRenderer.invoke(IpcChannel.folderRename, ref, name),
    remove: (ref: FolderRefDTO): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.folderDelete, ref),
    open: (ref: FolderRefDTO): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.folderOpen, ref),
    removeSource: (id: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.sourceRemove, id)
  },
  tags: {
    create: (dto: CreateTagDTO): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.tagCreate, dto),
    save: (dto: SaveTagDTO): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.tagSave, dto),
    remove: (id: number): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.tagDelete, id),
    createCategory: (): Promise<ApiResponse<TagCategoryVO>> => ipcRenderer.invoke(IpcChannel.tagCategoryCreate),
    renameCategory: (id: number, name: string): Promise<ApiResponse<string>> => ipcRenderer.invoke(IpcChannel.tagCategoryRename, id, name),
    setCategoryColor: (id: number, colorIndex: number): Promise<ApiResponse<void>> =>
      ipcRenderer.invoke(IpcChannel.tagCategorySetColor, id, colorIndex),
    removeCategory: (id: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.tagCategoryDelete, id)
  },
  scan: {
    start: (rootId: number | null): Promise<ApiResponse<ScanStateVO>> => ipcRenderer.invoke(IpcChannel.scanStart, rootId),
    stop: (): Promise<ApiResponse<ScanStateVO>> => ipcRenderer.invoke(IpcChannel.scanStop),
    getState: (): Promise<ApiResponse<ScanStateVO>> => ipcRenderer.invoke(IpcChannel.scanGetState),
    // 订阅扫描状态推送，返回取消订阅的函数
    onState: (fn: (state: ScanStateVO) => void): (() => void) => {
      const wrapped = (_event: IpcRendererEvent, state: ScanStateVO): void => fn(state)
      ipcRenderer.on(IpcEvent.scanState, wrapped)
      return () => ipcRenderer.removeListener(IpcEvent.scanState, wrapped)
    }
  },
  look: {
    state: (): Promise<ApiResponse<LookStateVO>> => ipcRenderer.invoke(IpcChannel.lookState),
    retry: (jobId: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.lookRetry, jobId),
    now: (imageId: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.lookNow, imageId),
    cancelAll: (): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.lookCancelAll),
    refreshSuggestion: (imageId: number): Promise<ApiResponse<SuggestionRefreshStatusVO>> =>
      ipcRenderer.invoke(IpcChannel.lookRefreshSuggestion, imageId),
    refreshStatus: (imageId: number): Promise<ApiResponse<SuggestionRefreshStatusVO>> =>
      ipcRenderer.invoke(IpcChannel.lookRefreshStatus, imageId),
    // 订阅看图队列的变化，返回取消订阅的函数
    onState: (listener: (state: LookStateVO) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: LookStateVO): void => listener(state)
      ipcRenderer.on(IpcEvent.lookState, handler)
      return () => ipcRenderer.removeListener(IpcEvent.lookState, handler)
    },
    // 订阅“有新的 AI 建议”
    onSuggested: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on(IpcEvent.aiSuggested, handler)
      return () => ipcRenderer.removeListener(IpcEvent.aiSuggested, handler)
    }
  },
  suggestion: {
    list: (imageId: number): Promise<ApiResponse<AiSuggestionVO[]>> => ipcRenderer.invoke(IpcChannel.suggestionList, imageId),
    decide: (imageId: number, key: string, accept: boolean, value?: string): Promise<ApiResponse<AiSuggestionVO[]>> =>
      ipcRenderer.invoke(IpcChannel.suggestionDecide, imageId, key, accept, value),
    acceptAll: (imageId: number, overrides?: Record<string, string>): Promise<ApiResponse<AiSuggestionVO[]>> =>
      ipcRenderer.invoke(IpcChannel.suggestionAcceptAll, imageId, overrides),
    assistPrompt: (imageId: number): Promise<ApiResponse<string>> => ipcRenderer.invoke(IpcChannel.assistPrompt, imageId),
    assistImport: (imageId: number, raw: unknown): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.assistImport, imageId, raw),
    decideMany: (imageIds: number[], accept: boolean): Promise<ApiResponse<SuggestionBatchVO>> =>
      ipcRenderer.invoke(IpcChannel.suggestionDecideMany, imageIds, accept)
  },
  organize: {
    state: (): Promise<ApiResponse<OrganizeStateVO>> => ipcRenderer.invoke(IpcChannel.organizeState),
    dismissEstimate: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.organizeDismissEstimate),
    estimate: (): Promise<ApiResponse<OrganizeEstimateVO>> => ipcRenderer.invoke(IpcChannel.organizeEstimate),
    start: (): Promise<ApiResponse<OrganizeStateVO>> => ipcRenderer.invoke(IpcChannel.organizeStart),
    approve: (plan: OrganizeFolderVO[]): Promise<ApiResponse<number>> => ipcRenderer.invoke(IpcChannel.organizeApprove, plan),
    cancel: (): Promise<ApiResponse<OrganizeStateVO>> => ipcRenderer.invoke(IpcChannel.organizeCancel),
    // 订阅一键整理的状态变化
    onState: (listener: (state: OrganizeStateVO) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: OrganizeStateVO): void => listener(state)
      ipcRenderer.on(IpcEvent.organizeState, handler)
      return () => ipcRenderer.removeListener(IpcEvent.organizeState, handler)
    }
  },
  reorganize: {
    estimate: (): Promise<ApiResponse<ReorganizeEstimateVO>> => ipcRenderer.invoke(IpcChannel.reorganizeEstimate),
    dismissEstimate: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.reorganizeDismissEstimate),
    resetToSource: (): Promise<ApiResponse<ReorganizeResetResultVO>> => ipcRenderer.invoke(IpcChannel.reorganizeResetToSource),
    relook: (): Promise<ApiResponse<ReorganizeRelookResultVO>> => ipcRenderer.invoke(IpcChannel.reorganizeRelook)
  },
  rating: {
    progress: (): Promise<ApiResponse<RatingProgressVO>> => ipcRenderer.invoke(IpcChannel.ratingProgress),
    // 订阅本地分级的进度
    onProgress: (listener: (p: RatingProgressVO) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, p: RatingProgressVO): void => listener(p)
      ipcRenderer.on(IpcEvent.ratingProgress, handler)
      return () => ipcRenderer.removeListener(IpcEvent.ratingProgress, handler)
    },
    // 订阅“本地分级判出了 R-18”，返回取消订阅的函数
    onR18: (listener: (count: number) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, count: number): void => listener(count)
      ipcRenderer.on(IpcEvent.ratingR18, handler)
      return () => ipcRenderer.removeListener(IpcEvent.ratingR18, handler)
    }
  },
  ai: {
    policy: (): Promise<ApiResponse<AiPolicyVO>> => ipcRenderer.invoke(IpcChannel.aiPolicy),
    referencePreviews: (ids: number[]): Promise<ApiResponse<AiReferencePreview[]>> => ipcRenderer.invoke(IpcChannel.aiReferencePreviews, ids),
    resetRules: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.aiResetRules),
    embeddingLimit: (value: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.aiEmbeddingLimit, value),
    changePreference: (id: number, content: string | null): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.aiPreference, id, content),
    categoryProposal: (id: number, messageId: number): Promise<ApiResponse<CategoryProposalVO>> => ipcRenderer.invoke(IpcChannel.categoryProposal, id, messageId),
    decideCategoryProposal: (id: number, messageId: number, apply: boolean): Promise<ApiResponse<CategoryProposalVO>> => ipcRenderer.invoke(IpcChannel.categoryProposalDecide, id, messageId, apply),
    status: (): Promise<ApiResponse<AiStatusVO>> => ipcRenderer.invoke(IpcChannel.aiStatus),
    ideas: (): Promise<ApiResponse<string[]>> => ipcRenderer.invoke(IpcChannel.aiIdeas),
    predict: (dto: AiPredictionDTO): Promise<ApiResponse<string | null>> => ipcRenderer.invoke(IpcChannel.aiPredict, dto),
    conversations: (): Promise<ApiResponse<AiConversationVO[]>> => ipcRenderer.invoke(IpcChannel.aiConversations),
    messages: (conversationId: number): Promise<ApiResponse<AiMessageVO[]>> => ipcRenderer.invoke(IpcChannel.aiMessages, conversationId),
    attachmentOriginal: (messageId: number): Promise<ApiResponse<string | null>> => ipcRenderer.invoke(IpcChannel.aiAttachmentOriginal, messageId),
    ask: (dto: AiAskDTO): Promise<ApiResponse<AiAskResultVO>> => ipcRenderer.invoke(IpcChannel.aiAsk, dto),
    editMessage: (id: number, messageId: number, text: string): Promise<ApiResponse<AiMessageVO>> => ipcRenderer.invoke(IpcChannel.aiEditMessage, id, messageId, text),
    recallMessage: (id: number, messageId: number): Promise<ApiResponse<AiRecalledDraft>> => ipcRenderer.invoke(IpcChannel.aiRecallMessage, id, messageId),
    recalledDraft: (id: number): Promise<ApiResponse<AiRecalledDraft | null>> => ipcRenderer.invoke(IpcChannel.aiRecalledDraft, id),
    compact: (id: number): Promise<ApiResponse<AiCompactResult>> => ipcRenderer.invoke(IpcChannel.aiCompact, id),
    onCompaction: (callback: (id: number, active: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: number, active: boolean) => callback(id, active)
      ipcRenderer.on(IpcEvent.aiCompaction, listener)
      return () => ipcRenderer.removeListener(IpcEvent.aiCompaction, listener)
    },
    onStream: (listener: (event: AiStreamEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: AiStreamEvent): void => listener(data)
      ipcRenderer.on(IpcEvent.aiStream, handler)
      return () => ipcRenderer.removeListener(IpcEvent.aiStream, handler)
    },
    answer: (conversationId: number): Promise<ApiResponse<AiMessageVO>> => ipcRenderer.invoke(IpcChannel.aiAnswer, conversationId),
    abort: (conversationId: number): Promise<ApiResponse<boolean>> => ipcRenderer.invoke(IpcChannel.aiAbort, conversationId),
    rename: (id: number, title: string): Promise<ApiResponse<AiConversationVO>> => ipcRenderer.invoke(IpcChannel.aiRename, id, title),
    pin: (id: number, pinned: boolean): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.aiPin, id, pinned),
    remove: (id: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.aiDelete, id),
    undoRemove: (id: number): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.aiUndoDelete, id),
    vote: (messageId: number, vote: 'UP' | 'DOWN' | null): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.aiVote, messageId, vote)
  },
  window: {
    setTheme: (theme: ThemeMode): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowSetTheme, theme),
    minimize: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowMinimize),
    toggleMaximize: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowToggleMaximize),
    close: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowClose)
  }
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
