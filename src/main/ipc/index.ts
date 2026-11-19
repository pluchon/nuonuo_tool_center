import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel, type AddTagDTO, type CreateTagDTO, type GalleryQueryDTO, type SaveTagDTO, type ThemeMode } from '@shared/api'
import type { DataPaths } from '../config/paths'
import { BizError } from '../common/bizError'
import { bootDatabase, getDbBootState, type DatabaseLocation } from '../services/databaseService'
import { deleteImages, recoverFileOps, undoDelete } from '../services/fileOps/fileOpsService'
import { listFolders } from '../services/folderService'
import { getImageDetail, listGallery, listUntaggedDirs, openFileWithDefault, showFileInFolder } from '../services/galleryService'
import { addTag, getCommonTags, getTagCatalog, removeTag, renameImage, setR18 } from '../services/imageEditService'
import { addRoot, getOverview, relocateRoot } from '../services/libraryService'
import {
  createCategory,
  createTag,
  deleteTag,
  removeCategory,
  renameCategory,
  saveTag,
  setCategoryColor
} from '../services/tagManageService'
import { getScanState, startScan, stopScan } from '../services/scan/scanService'
import { getSettings, updateSettings } from '../services/settingsService'
import { applyWindowTheme, toggleMaximize } from '../window/windowControl'
import { handle } from './handle'

// 取发起调用的窗口；窗口已关闭时报错
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) {
    throw new BizError('NOT_FOUND', '窗口已关闭')
  }
  return win
}

// 需要数据库的调用先确认数据库已打开
function requireDatabase(): void {
  if (getDbBootState() !== 'READY') {
    throw new BizError('DEPENDENCY_FAILED', '图库数据还没打开')
  }
}

// 注册全部 IPC 处理器：只做参数绑定与调用服务
export function registerIpcHandlers(paths: DataPaths, location: DatabaseLocation): void {
  handle(IpcChannel.systemGetBootState, async () => getDbBootState())
  handle(IpcChannel.systemRetryDatabase, async () => {
    const state = await bootDatabase(location)
    // 重试打开成功：先把上次没做完的文件操作补做完
    if (state === 'READY') {
      await recoverFileOps()
    }
    return state
  })

  handle(IpcChannel.settingsGet, async () => {
    requireDatabase()
    return getSettings()
  })
  handle(IpcChannel.settingsUpdate, async (_event, patch: unknown) => {
    requireDatabase()
    return updateSettings(patch)
  })

  handle(IpcChannel.libraryGetOverview, async () => {
    requireDatabase()
    return getOverview(paths.categoryHomeOverride)
  })
  handle(IpcChannel.libraryAddRoot, async (_event, path: string) => {
    requireDatabase()
    return addRoot(path, paths.categoryHomeOverride)
  })
  handle(IpcChannel.libraryRelocateRoot, async (_event, id: number, path: string) => {
    requireDatabase()
    if (!Number.isInteger(id)) {
      throw new BizError('BAD_REQUEST', '目录 id 不对')
    }
    return relocateRoot(id, path, paths.categoryHomeOverride)
  })
  handle(IpcChannel.libraryListFolders, async (_event, parent: string | null) => {
    requireDatabase()
    return listFolders(parent, paths.categoryHomeOverride)
  })

  handle(IpcChannel.scanStart, async (_event, rootId: number | null) => {
    requireDatabase()
    if (rootId !== null && !Number.isInteger(rootId)) {
      throw new BizError('BAD_REQUEST', '目录 id 不对')
    }
    return startScan(rootId)
  })
  handle(IpcChannel.scanStop, async () => stopScan())

  handle(IpcChannel.galleryList, async (_event, query: GalleryQueryDTO) => {
    requireDatabase()
    return listGallery(query)
  })
  handle(IpcChannel.galleryDetail, async (_event, imageId: number) => {
    requireDatabase()
    return getImageDetail(imageId)
  })
  handle(IpcChannel.fileShowInFolder, async (_event, fileId: number) => {
    requireDatabase()
    await showFileInFolder(fileId)
  })
  handle(IpcChannel.galleryUntaggedDirs, async () => {
    requireDatabase()
    return listUntaggedDirs()
  })
  handle(IpcChannel.tagCatalog, async () => {
    requireDatabase()
    return getTagCatalog()
  })
  handle(IpcChannel.imageRename, async (_event, imageId: number, name: string | null) => {
    requireDatabase()
    return renameImage(imageId, name)
  })
  handle(IpcChannel.imageSetR18, async (_event, imageIds: number[], value: boolean) => {
    requireDatabase()
    return setR18(imageIds, value)
  })
  handle(IpcChannel.imageAddTag, async (_event, dto: AddTagDTO) => {
    requireDatabase()
    return addTag(dto)
  })
  handle(IpcChannel.imageRemoveTag, async (_event, imageIds: number[], tagId: number) => {
    requireDatabase()
    return removeTag(imageIds, tagId)
  })
  handle(IpcChannel.imageCommonTags, async (_event, imageIds: number[]) => {
    requireDatabase()
    return getCommonTags(imageIds)
  })
  handle(IpcChannel.tagCreate, async (_event, dto: CreateTagDTO) => {
    requireDatabase()
    return createTag(dto)
  })
  handle(IpcChannel.tagSave, async (_event, dto: SaveTagDTO) => {
    requireDatabase()
    return saveTag(dto)
  })
  handle(IpcChannel.tagDelete, async (_event, id: number) => {
    requireDatabase()
    return deleteTag(id)
  })
  handle(IpcChannel.tagCategoryCreate, async () => {
    requireDatabase()
    return createCategory()
  })
  handle(IpcChannel.tagCategoryRename, async (_event, id: number, name: string) => {
    requireDatabase()
    return renameCategory(id, name)
  })
  handle(IpcChannel.tagCategorySetColor, async (_event, id: number, colorIndex: number) => {
    requireDatabase()
    await setCategoryColor(id, colorIndex)
  })
  handle(IpcChannel.tagCategoryDelete, async (_event, id: number) => {
    requireDatabase()
    await removeCategory(id)
  })
  handle(IpcChannel.fileDelete, async (_event, query: GalleryQueryDTO, imageIds: number[]) => {
    requireDatabase()
    return deleteImages(query, imageIds)
  })
  handle(IpcChannel.fileUndoDelete, async (_event, batchId: number) => {
    requireDatabase()
    await undoDelete(batchId)
  })
  handle(IpcChannel.fileOpen, async (_event, fileId: number) => {
    requireDatabase()
    await openFileWithDefault(fileId)
  })
  handle(IpcChannel.scanGetState, async () => getScanState())

  handle(IpcChannel.windowSetTheme, async (event, theme: ThemeMode) => {
    if (theme !== 'light' && theme !== 'dark') {
      throw new BizError('BAD_REQUEST', '未知主题')
    }
    applyWindowTheme(senderWindow(event), theme)
  })
  handle(IpcChannel.windowMinimize, async (event) => {
    senderWindow(event).minimize()
  })
  handle(IpcChannel.windowToggleMaximize, async (event) => {
    toggleMaximize(senderWindow(event))
  })
  handle(IpcChannel.windowClose, async (event) => {
    senderWindow(event).close()
  })
}
