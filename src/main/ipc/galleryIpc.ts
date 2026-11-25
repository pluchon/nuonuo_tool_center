import { IpcChannel, type AddTagDTO, type CreateTagDTO, type FolderRefDTO, type GalleryQueryDTO, type SaveTagDTO } from '@shared/api'
import { BizError } from '../common/bizError'
import type { DataPaths } from '../config/paths'
import { deleteImages, undoDelete } from '../services/fileOps/fileOpsService'
import { createFolder, deleteCategoryFolder, removeSource, renameCategoryFolder } from '../services/fileOps/folderOpsService'
import { startNativeDrag } from '../services/fileOps/nativeDragService'
import { copyImages, moveImages, undoTransfer } from '../services/fileOps/transferService'
import { dirChildren, listFolders, openFolder, transferRoots } from '../services/folderService'
import {
  copyImageToClipboard,
  getImageDetail,
  invalidateRootOnlineCache,
  listGallery,
  listUntaggedDirs,
  openFileWithDefault,
  showFileInFolder
} from '../services/galleryService'
import { addTag, getCommonTags, getTagCatalog, removeTag, renameImage, setR18 } from '../services/imageEditService'
import { addRoot, getOverview, relocateRoot } from '../services/libraryService'
import { prioritizeRating } from '../services/rating/ratingService'
import { getScanState, startScan, stopScan } from '../services/scan/scanService'
import { syncWatching } from '../services/scan/watchService'
import {
  createCategory,
  createTag,
  deleteTag,
  removeCategory,
  renameCategory,
  saveTag,
  setCategoryColor
} from '../services/tagManageService'
import { handle } from './handle'
import { refreshImageIndex, requireDatabase } from './shared'

// 注册图库、扫描、网格、编辑、标签、文件操作与目录管理 IPC 处理器
export function registerGalleryIpc(paths: DataPaths): void {
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
    const updated = await relocateRoot(id, path, paths.categoryHomeOverride)
    invalidateRootOnlineCache(id)
    return updated
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
}
