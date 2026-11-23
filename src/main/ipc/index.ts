import { app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import {
  IpcChannel,
  organizeUsesLookQueue,
  type AddTagDTO,
  type AiAskDTO,
  type CreateTagDTO,
  type FolderRefDTO,
  type GalleryQueryDTO,
  type SaveTagDTO,
  type ThemeMode
} from '@shared/api'
import type { DataPaths } from '../config/paths'
import { BizError } from '../common/bizError'
import { bootDatabase, getDbBootState, type DatabaseLocation } from '../services/databaseService'
import { deleteImages, recoverFileOps, undoDelete } from '../services/fileOps/fileOpsService'
import { copyImages, moveImages, undoTransfer } from '../services/fileOps/transferService'
import { createFolder, deleteCategoryFolder, removeSource, renameCategoryFolder } from '../services/fileOps/folderOpsService'
import { dirChildren, listFolders, openFolder, transferRoots } from '../services/folderService'
import {
  copyImageToClipboard,
  getImageDetail,
  listGallery,
  listUntaggedDirs,
  openFileWithDefault,
  showFileInFolder
} from '../services/galleryService'
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
import { getAiCredentialStatus, saveAiCredentialSettings } from '../services/aiCredentialSettings'
import { categoryHomeOf, changeCategoryHome } from '../services/categoryHome'
import { backupFileName, cleanThumbCache, exportBackup, folderBytes, importCustomBackground } from '../services/systemService'
import { applySystemSettings } from '../window/systemSettings'
import { syncWatching } from '../services/scan/watchService'
import { applyWindowTheme, toggleMaximize } from '../window/windowControl'
import {
  answer,
  ask,
  deleteConversation,
  getAiStatus,
  listConversations,
  listMessages,
  pinConversation,
  renameConversation,
  suggestIdeas,
  undoDeleteConversation,
  voteMessage
} from '../services/ai/assistantService'
import { cancelAllLooks, getLookState, lookNow, retryLook } from '../services/ai/lookService'
import { scheduleEmbedding } from '../services/ai/embeddingService'
import { startNativeDrag } from '../services/fileOps/nativeDragService'
import { acceptAllSuggestions, assistPrompt, decideMany, decideSuggestion, importAssist, listSuggestions } from '../services/ai/suggestionService'
import { approveOrganize, cancelOrganize, estimateOrganize, getOrganizeState, startOrganize } from '../services/ai/organizeService'
import { getRatingProgress, prioritizeRating } from '../services/rating/ratingService'
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

// 标签或复核状态提交成功后，已有图库可能首次出现可建立向量索引的图片。
function refreshImageIndex<T>(result: T): T {
  scheduleEmbedding()
  return result
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
    const next = await updateSettings(patch)
    applySystemSettings(next, patch as Record<string, unknown>)
    if (Object.hasOwn(patch as object, 'watchChanges') || Object.hasOwn(patch as object, 'categoryHome')) {
      await syncWatching()
    }
    return next
  })
  handle(IpcChannel.settingsGetAiCredentials, async () => getAiCredentialStatus())
  handle(IpcChannel.settingsSaveAiCredentials, async (_event, patch: unknown) => saveAiCredentialSettings(patch))
  // 更改类目录保存的位置：系统的选文件夹对话框，取消返回 null
  handle(IpcChannel.settingsPickCategoryHome, async (event) => {
    requireDatabase()
    const picked = await dialog.showOpenDialog(senderWindow(event), { title: '类目录保存的位置', properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || picked.filePaths.length === 0) {
      return null
    }
    await changeCategoryHome(picked.filePaths[0], paths.categoryHomeOverride, paths.root)
    await syncWatching()
    return getSettings()
  })
  // 自定义背景：选一张图，缩好存进数据目录再换上；取消返回 null
  handle(IpcChannel.settingsPickBackground, async (event) => {
    requireDatabase()
    const picked = await dialog.showOpenDialog(senderWindow(event), {
      title: '选一张背景图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return null
    }
    const name = await importCustomBackground(picked.filePaths[0], paths.backgrounds)
    return updateSettings({ background: 'custom', customBackground: name })
  })

  handle(IpcChannel.systemDataInfo, async () => {
    requireDatabase()
    return {
      dataDir: paths.root,
      cacheBytes: await folderBytes(paths.thumbs),
      version: app.getVersion(),
      categoryHome: await categoryHomeOf(paths.categoryHomeOverride),
      categoryHomeLocked: paths.categoryHomeOverride !== null
    }
  })
  // Windows 自己的选文件夹对话框（导入源目录、重新选择位置、复制 / 移动到其他位置）；取消返回 null
  handle(IpcChannel.systemPickFolder, async (event, title: unknown) => {
    const picked = await dialog.showOpenDialog(senderWindow(event), {
      title: typeof title === 'string' && title.length <= 40 ? title : '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  })
  handle(IpcChannel.systemOpenDataDir, async () => {
    const err = await shell.openPath(paths.root)
    if (err) {
      throw new BizError('DEPENDENCY_FAILED', `打不开文件夹：${err}`)
    }
  })
  handle(IpcChannel.systemCleanCache, async () => {
    requireDatabase()
    return cleanThumbCache(paths.thumbs)
  })
  // 导出备份：系统的保存对话框选位置，取消返回 null
  handle(IpcChannel.systemExportBackup, async (event) => {
    requireDatabase()
    const picked = await dialog.showSaveDialog(senderWindow(event), {
      title: '导出备份',
      defaultPath: join(app.getPath('documents'), backupFileName(new Date())),
      filters: [{ name: '备份', extensions: ['gz'] }]
    })
    if (picked.canceled || !picked.filePath) {
      return null
    }
    await exportBackup(picked.filePath)
    return picked.filePath
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
    // 你正在看的这张还没分级：插到最前面先判
    void prioritizeRating(imageId).catch(() => undefined)
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
    return setR18(imageIds, value).then(refreshImageIndex)
  })
  handle(IpcChannel.imageAddTag, async (_event, dto: AddTagDTO) => {
    requireDatabase()
    return addTag(dto).then(refreshImageIndex)
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
  handle(IpcChannel.fileTransferRoots, async () => {
    requireDatabase()
    return transferRoots(paths.categoryHomeOverride)
  })
  handle(IpcChannel.fileMove, async (_event, query: GalleryQueryDTO, imageIds: number[], target: string) => {
    requireDatabase()
    return moveImages(query, imageIds, target)
  })
  handle(IpcChannel.fileCopy, async (_event, query: GalleryQueryDTO, imageIds: number[], targets: string[]) => {
    requireDatabase()
    return copyImages(query, imageIds, targets)
  })
  handle(IpcChannel.fileUndoTransfer, async (_event, batchId: number) => {
    requireDatabase()
    return undoTransfer(batchId)
  })
  handle(IpcChannel.libraryDirChildren, async (_event, ref: FolderRefDTO) => {
    requireDatabase()
    return dirChildren(ref)
  })
  handle(IpcChannel.folderCreate, async (_event, parent: FolderRefDTO, name: string | null) => {
    requireDatabase()
    return createFolder(parent, name)
  })
  handle(IpcChannel.folderRename, async (_event, ref: FolderRefDTO, name: string) => {
    requireDatabase()
    return renameCategoryFolder(ref, name)
  })
  handle(IpcChannel.folderDelete, async (_event, ref: FolderRefDTO) => {
    requireDatabase()
    return deleteCategoryFolder(ref)
  })
  handle(IpcChannel.folderOpen, async (_event, ref: FolderRefDTO) => {
    requireDatabase()
    await openFolder(ref)
  })
  handle(IpcChannel.fileStartDrag, async (event, fileIds: number[], hash: string) => {
    requireDatabase()
    return startNativeDrag(event.sender, paths.thumbs, fileIds, hash)
  })
  handle(IpcChannel.fileCopyImage, async (_event, fileId: number) => {
    requireDatabase()
    await copyImageToClipboard(fileId)
  })
  handle(IpcChannel.sourceRemove, async (_event, id: number) => {
    requireDatabase()
    await removeSource(id)
    await syncWatching()
  })
  handle(IpcChannel.fileOpen, async (_event, fileId: number) => {
    requireDatabase()
    await openFileWithDefault(fileId)
  })
  handle(IpcChannel.scanGetState, async () => getScanState())

  handle(IpcChannel.aiStatus, async () => getAiStatus())
  handle(IpcChannel.aiIdeas, async () => {
    requireDatabase()
    return suggestIdeas()
  })
  handle(IpcChannel.aiConversations, async () => {
    requireDatabase()
    return listConversations()
  })
  handle(IpcChannel.aiMessages, async (_event, conversationId: number) => {
    requireDatabase()
    return listMessages(conversationId)
  })
  handle(IpcChannel.aiAsk, async (_event, dto: AiAskDTO) => {
    requireDatabase()
    return ask(dto)
  })
  handle(IpcChannel.aiAnswer, async (_event, conversationId: number) => {
    requireDatabase()
    return answer(conversationId)
  })
  handle(IpcChannel.aiRename, async (_event, id: number, title: string) => {
    requireDatabase()
    return renameConversation(id, title)
  })
  handle(IpcChannel.aiPin, async (_event, id: number, pinned: boolean) => {
    requireDatabase()
    await pinConversation(id, pinned)
  })
  handle(IpcChannel.aiDelete, async (_event, id: number) => {
    requireDatabase()
    await deleteConversation(id)
  })
  handle(IpcChannel.aiUndoDelete, async (_event, id: number) => {
    requireDatabase()
    await undoDeleteConversation(id)
  })
  handle(IpcChannel.aiVote, async (_event, messageId: number, vote: 'UP' | 'DOWN' | null) => {
    requireDatabase()
    await voteMessage(messageId, vote)
  })
  handle(IpcChannel.lookState, async () => {
    requireDatabase()
    return getLookState()
  })
  handle(IpcChannel.lookRetry, async (_event, jobId: number) => {
    requireDatabase()
    if (!Number.isInteger(jobId)) {
      throw new BizError('BAD_REQUEST', '任务 id 不对')
    }
    await retryLook(jobId)
  })
  handle(IpcChannel.lookNow, async (_event, imageId: number) => {
    requireDatabase()
    if (!Number.isInteger(imageId)) {
      throw new BizError('BAD_REQUEST', '图片 id 不对')
    }
    await lookNow(imageId)
  })
  handle(IpcChannel.lookCancelAll, async () => {
    requireDatabase()
    if (organizeUsesLookQueue(getOrganizeState().phase)) {
      throw new BizError('CONFLICT', '请从一键整理停止当前整理')
    }
    return cancelAllLooks()
  })
  handle(IpcChannel.suggestionList, async (_event, imageId: number) => {
    requireDatabase()
    return listSuggestions(imageId)
  })
  handle(IpcChannel.suggestionDecide, async (_event, imageId: number, key: string, accept: boolean) => {
    requireDatabase()
    if (typeof key !== 'string' || typeof accept !== 'boolean') {
      throw new BizError('BAD_REQUEST', '参数不对')
    }
    return decideSuggestion(imageId, key, accept).then(refreshImageIndex)
  })
  handle(IpcChannel.suggestionAcceptAll, async (_event, imageId: number) => {
    requireDatabase()
    return acceptAllSuggestions(imageId).then(refreshImageIndex)
  })
  handle(IpcChannel.suggestionDecideMany, async (_event, imageIds: unknown, accept: unknown) => {
    requireDatabase()
    if (typeof accept !== 'boolean') {
      throw new BizError('BAD_REQUEST', '参数不对')
    }
    return decideMany(imageIds, accept).then(refreshImageIndex)
  })
  handle(IpcChannel.ratingProgress, async () => getRatingProgress())
  handle(IpcChannel.organizeState, async () => {
    requireDatabase()
    return getOrganizeState()
  })
  handle(IpcChannel.organizeEstimate, async () => {
    requireDatabase()
    return estimateOrganize()
  })
  handle(IpcChannel.organizeStart, async () => {
    requireDatabase()
    return startOrganize()
  })
  handle(IpcChannel.organizeApprove, async (_event, plan: unknown) => {
    requireDatabase()
    return approveOrganize(plan)
  })
  handle(IpcChannel.organizeCancel, async () => {
    requireDatabase()
    return cancelOrganize()
  })
  handle(IpcChannel.assistPrompt, async (_event, imageId: number) => {
    requireDatabase()
    return assistPrompt(imageId)
  })
  handle(IpcChannel.assistImport, async (_event, imageId: number, raw: unknown) => {
    requireDatabase()
    return importAssist(imageId, raw)
  })

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
