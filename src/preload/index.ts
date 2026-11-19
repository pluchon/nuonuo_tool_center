import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  IpcEvent,
  type AddTagDTO,
  type AddTagResultVO,
  type ApiResponse,
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
  type ThemeMode
} from '@shared/api'

// 暴露给渲染进程的接口：只开放具体方法，不暴露 ipcRenderer 本身
const api = {
  system: {
    getBootState: (): Promise<ApiResponse<DbBootState>> => ipcRenderer.invoke(IpcChannel.systemGetBootState),
    retryDatabase: (): Promise<ApiResponse<DbBootState>> => ipcRenderer.invoke(IpcChannel.systemRetryDatabase)
  },
  settings: {
    get: (): Promise<ApiResponse<AppSettings>> => ipcRenderer.invoke(IpcChannel.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<ApiResponse<AppSettings>> =>
      ipcRenderer.invoke(IpcChannel.settingsUpdate, patch)
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
  window: {
    setTheme: (theme: ThemeMode): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowSetTheme, theme),
    minimize: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowMinimize),
    toggleMaximize: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowToggleMaximize),
    close: (): Promise<ApiResponse<void>> => ipcRenderer.invoke(IpcChannel.windowClose)
  }
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
