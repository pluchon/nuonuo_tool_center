import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isReactive, nextTick, watch } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { GalleryItemVO, ImageDetailVO, LibraryOverviewVO, TagCatalogVO } from '@shared/api'

const mockApi = vi.hoisted(() => ({
  fetchGallery: vi.fn(),
  fetchImageDetail: vi.fn(),
  renameImage: vi.fn(),
  setImagesR18: vi.fn(),
  addImageTag: vi.fn(),
  removeImageTag: vi.fn(),
  fetchCommonTags: vi.fn(),
  fetchTagCatalog: vi.fn(),
  deleteImages: vi.fn(),
  undoDelete: vi.fn(),
  fetchLibraryOverview: vi.fn()
}))

vi.mock('@/api/gallery', () => ({
  fetchGallery: mockApi.fetchGallery,
  fetchImageDetail: mockApi.fetchImageDetail
}))

vi.mock('@/api/edit', () => ({
  renameImage: mockApi.renameImage,
  setImagesR18: mockApi.setImagesR18,
  addImageTag: mockApi.addImageTag,
  removeImageTag: mockApi.removeImageTag,
  fetchCommonTags: mockApi.fetchCommonTags,
  fetchTagCatalog: mockApi.fetchTagCatalog
}))

vi.mock('@/api/files', () => ({
  deleteImages: mockApi.deleteImages,
  undoDelete: mockApi.undoDelete,
  copyImageToClipboard: vi.fn(),
  moveImages: vi.fn(),
  copyImages: vi.fn(),
  fetchTransferRoots: vi.fn(),
  undoTransfer: vi.fn()
}))

vi.mock('@/api/library', () => ({
  fetchLibraryOverview: mockApi.fetchLibraryOverview,
  importSourceRoot: vi.fn(),
  relocateSourceRoot: vi.fn()
}))

vi.mock('@/api/tags', () => ({
  createCategory: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  removeCategory: vi.fn(),
  renameCategory: vi.fn(),
  saveTag: vi.fn(),
  setCategoryColor: vi.fn()
}))

vi.mock('@/api/settings', () => ({
  fetchSettings: vi.fn(),
  saveSettings: vi.fn(),
  pickBackground: vi.fn()
}))

vi.mock('@/api/system', () => ({
  pickFolder: vi.fn()
}))

vi.mock('@/utils/gridLayout', () => ({
  DEFAULT_ZOOM: 2,
  ROW_HEIGHTS: [110, 140, 180, 230, 300]
}))

vi.mock('@/theme/tagPalette', () => ({
  tagColor: () => ({ bg: '', ink: '', line: '', dot: '' })
}))

const storeModules = {
  gallery: '../../src/renderer/src/stores/gallery.ts',
  view: '../../src/renderer/src/stores/view.ts',
  toast: '../../src/renderer/src/stores/toast.ts'
}

type GalleryStoreModule = {
  useGalleryStore: () => {
    q: string
    sort: string
    onlyR18: boolean
    onlyHere: boolean
    tagIds: number[]
    items: GalleryItemVO[]
    selected: number[]
    selectedSet: ReadonlySet<number>
    isSelected: (id: number) => boolean
    primary: number | null
    primaryItem: GalleryItemVO | undefined
    detail: ImageDetailVO | null
    load: () => Promise<void>
    selectOne: (id: number | null) => void
    toggle: (id: number) => void
    selectRange: (id: number) => void
    setMany: (ids: number[], primary?: number) => void
    collapse: () => void
    patchItemsLocally: (ids: number[], patcher: (item: GalleryItemVO) => GalleryItemVO) => void
    removeItemsLocally: (ids: number[]) => void
    rename: (name: string) => Promise<boolean>
    setR18: (value: boolean) => Promise<void>
    addTag: (name: string, categoryId?: number) => Promise<boolean>
    removeTag: (tagId: number) => Promise<void>
    runDelete: (ids: number[]) => Promise<void>
  }
}

type ViewStoreModule = {
  useViewStore: () => {
    show: (view: 'all' | 'untagged' | 'recent' | 'r18' | 'ai') => void
    showDir: (dir: { kind: 'source'; id: number; sub?: string } | { kind: 'category'; name: string }) => void
  }
}

type ToastStoreModule = {
  useToastStore: () => {
    undo: () => Promise<void>
    close: () => void
  }
}

const { useGalleryStore } = (await import(storeModules.gallery)) as GalleryStoreModule
const { useViewStore } = (await import(storeModules.view)) as ViewStoreModule
const { useToastStore } = (await import(storeModules.toast)) as ToastStoreModule

function makeItem(id: number, overrides: Partial<GalleryItemVO> = {}): GalleryItemVO {
  return {
    imageId: id,
    fileId: id * 10,
    name: `pic_${id}.jpg`,
    format: 'JPG',
    width: 1200,
    height: 800,
    byteSize: 1024,
    hash: `hash_${id}`,
    thumb: 'READY',
    missing: false,
    offline: false,
    isR18: false,
    tagged: true,
    importedAt: '2026-11-01T00:00:00.000Z',
    takenAt: null,
    ...overrides
  }
}

function makeDetail(item: GalleryItemVO, overrides: Partial<ImageDetailVO> = {}): ImageDetailVO {
  return {
    ...item,
    r18ByModel: false,
    exif: null,
    displayName: null,
    tags: [{ id: 1, name: '猫', categoryId: 1 }],
    locations: [{ fileId: item.fileId, path: `D:\\pics\\${item.name}`, missing: false, offline: false }],
    ...overrides
  }
}

const emptyOverview: LibraryOverviewVO = {
  counts: { total: 0, tagged: 0, untagged: 0, recent: 0, r18: 0, tags: 0, aiSuggest: 0 },
  sources: [],
  categories: [],
  lastScanAt: null
}

const emptyCatalog: TagCatalogVO = {
  categories: [],
  tags: []
}

describe('useGalleryStore (shallowRef & incremental edits)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {})
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockApi.fetchLibraryOverview.mockResolvedValue(emptyOverview)
    mockApi.fetchTagCatalog.mockResolvedValue(emptyCatalog)
    mockApi.fetchCommonTags.mockResolvedValue([])
  })

  afterEach(() => {
    useToastStore().close()
    vi.unstubAllGlobals()
  })

  it('uses shallowRef for items without deep proxy wrapping while staying reactive on replacement', async () => {
    const items = [makeItem(1), makeItem(2)]
    mockApi.fetchGallery.mockResolvedValue({ items })
    mockApi.fetchImageDetail.mockResolvedValue(makeDetail(items[0]))

    const gallery = useGalleryStore()
    const observedLengths: number[] = []
    watch(
      () => gallery.items,
      (list) => {
        observedLengths.push(list.length)
      }
    )

    await gallery.load()
    await nextTick()

    expect(isReactive(gallery.items)).toBe(false)
    expect(isReactive(gallery.items[0])).toBe(false)
    expect(observedLengths).toEqual([2])

    gallery.patchItemsLocally([1], (it) => ({ ...it, name: 'updated' }))
    await nextTick()

    expect(isReactive(gallery.items)).toBe(false)
    expect(isReactive(gallery.items[0])).toBe(false)
    expect(gallery.primaryItem?.name).toBe('updated')
    expect(observedLengths).toEqual([2, 2])
  })

  it('rename patches name locally without calling fetchGallery / fetchLibraryOverview / fetchTagCatalog', async () => {
    const item1 = makeItem(1, { name: 'raw_1.png' })
    const item2 = makeItem(2, { name: 'raw_2.png' })
    mockApi.fetchGallery.mockResolvedValue({ items: [item1, item2] })
    mockApi.fetchImageDetail.mockResolvedValueOnce(makeDetail(item1)).mockResolvedValueOnce(
      makeDetail({ ...item1, name: '小猫' }, { displayName: '小猫' })
    )
    mockApi.renameImage.mockResolvedValue('小猫')

    const gallery = useGalleryStore()
    await gallery.load()
    vi.clearAllMocks()

    const ok = await gallery.rename('小猫')
    expect(ok).toBe(true)
    expect(gallery.items[0].name).toBe('小猫')
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchLibraryOverview).not.toHaveBeenCalled()
    expect(mockApi.fetchTagCatalog).not.toHaveBeenCalled()
    expect(mockApi.fetchImageDetail).toHaveBeenCalledWith(1)
  })

  it('rename clearing display name syncs fallback filename from detail without full reload', async () => {
    const item1 = makeItem(1, { name: '自定义名' })
    mockApi.fetchGallery.mockResolvedValue({ items: [item1] })
    mockApi.fetchImageDetail.mockResolvedValueOnce(makeDetail(item1, { displayName: '自定义名' })).mockResolvedValueOnce(
      makeDetail({ ...item1, name: 'origin.jpg' }, { displayName: null })
    )
    mockApi.renameImage.mockResolvedValue(null)

    const gallery = useGalleryStore()
    await gallery.load()
    vi.clearAllMocks()

    const ok = await gallery.rename('')
    expect(ok).toBe(true)
    expect(gallery.items[0].name).toBe('origin.jpg')
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchLibraryOverview).not.toHaveBeenCalled()
    expect(mockApi.fetchTagCatalog).not.toHaveBeenCalled()
  })

  it('rename falls back to fetchGallery when sort is name or q is non-empty', async () => {
    const item1 = makeItem(1, { name: 'a.jpg' })
    mockApi.fetchGallery.mockResolvedValue({ items: [item1] })
    mockApi.fetchImageDetail.mockResolvedValue(makeDetail(item1))
    mockApi.renameImage.mockResolvedValue('z')

    const gallery = useGalleryStore()
    await gallery.load()

    gallery.sort = 'name'
    vi.clearAllMocks()
    await gallery.rename('z')
    expect(mockApi.fetchGallery).toHaveBeenCalledTimes(1)
    expect(mockApi.fetchLibraryOverview).not.toHaveBeenCalled()
    expect(mockApi.fetchTagCatalog).not.toHaveBeenCalled()

    gallery.sort = 'new'
    gallery.q = 'cat'
    vi.clearAllMocks()
    await gallery.rename('z')
    expect(mockApi.fetchGallery).toHaveBeenCalledTimes(1)
  })

  it('setR18(false) in r18 view removes items locally without fetchGallery; in all view patches isR18 locally', async () => {
    const viewStore = useViewStore()
    const items = [makeItem(1, { isR18: true }), makeItem(2, { isR18: true })]
    mockApi.fetchGallery.mockResolvedValue({ items })
    mockApi.fetchImageDetail.mockImplementation(async (id: number) =>
      makeDetail(items.find((i) => i.imageId === id) ?? items[0])
    )
    mockApi.setImagesR18.mockResolvedValue(1)

    viewStore.show('r18')
    const gallery = useGalleryStore()
    await gallery.load()
    vi.clearAllMocks()

    await gallery.setR18(false)
    expect(gallery.items.map((i) => i.imageId)).toEqual([2])
    expect(gallery.primary).toBe(2)
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchLibraryOverview).toHaveBeenCalledTimes(1)
    expect(mockApi.fetchTagCatalog).not.toHaveBeenCalled()

    viewStore.show('all')
    mockApi.fetchGallery.mockResolvedValue({ items: [makeItem(10, { isR18: false })] })
    await gallery.load()
    vi.clearAllMocks()

    await gallery.setR18(true)
    expect(gallery.items[0].isR18).toBe(true)
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchImageDetail).toHaveBeenCalledWith(10)
    expect(mockApi.fetchLibraryOverview).toHaveBeenCalledTimes(1)
    expect(mockApi.fetchTagCatalog).not.toHaveBeenCalled()
  })

  it('addTag in untagged view removes items locally without fetchGallery; in dir view patches tagged=true', async () => {
    const viewStore = useViewStore()
    const items = [makeItem(1, { tagged: false }), makeItem(2, { tagged: false })]
    mockApi.fetchGallery.mockResolvedValue({ items })
    mockApi.fetchImageDetail.mockImplementation(async (id: number) =>
      makeDetail(items.find((i) => i.imageId === id) ?? items[0])
    )
    mockApi.addImageTag.mockResolvedValue({
      tag: { id: 9, name: '猫', categoryId: 1 },
      added: 1,
      already: 0,
      skipped: 0
    })

    viewStore.show('untagged')
    const gallery = useGalleryStore()
    await gallery.load()
    vi.clearAllMocks()

    const ok = await gallery.addTag('猫')
    expect(ok).toBe(true)
    expect(gallery.items.map((i) => i.imageId)).toEqual([2])
    expect(gallery.primary).toBe(2)
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchLibraryOverview).toHaveBeenCalledTimes(1)
    expect(mockApi.fetchTagCatalog).toHaveBeenCalledTimes(1)

    viewStore.showDir({ kind: 'source', id: 1 })
    const dirItem = makeItem(5, { tagged: false })
    mockApi.fetchGallery.mockResolvedValue({ items: [dirItem] })
    mockApi.fetchImageDetail.mockResolvedValue(makeDetail(dirItem))
    await gallery.load()
    vi.clearAllMocks()

    await gallery.addTag('猫')
    expect(gallery.items[0].tagged).toBe(true)
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchImageDetail).toHaveBeenCalledWith(5)
    expect(mockApi.fetchLibraryOverview).toHaveBeenCalledTimes(1)
    expect(mockApi.fetchTagCatalog).toHaveBeenCalledTimes(1)
  })

  it('removeTag in dir view syncs tagged state from detail without fetchGallery', async () => {
    const viewStore = useViewStore()
    viewStore.showDir({ kind: 'source', id: 1 })
    const item = makeItem(7, { tagged: true })
    mockApi.fetchGallery.mockResolvedValue({ items: [item] })
    mockApi.fetchImageDetail
      .mockResolvedValueOnce(makeDetail(item))
      .mockResolvedValueOnce(makeDetail({ ...item, tagged: false }, { tags: [] }))
    mockApi.removeImageTag.mockResolvedValue(1)

    const gallery = useGalleryStore()
    await gallery.load()
    vi.clearAllMocks()

    await gallery.removeTag(1)
    expect(gallery.items[0].tagged).toBe(false)
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchLibraryOverview).toHaveBeenCalledTimes(1)
    expect(mockApi.fetchTagCatalog).toHaveBeenCalledTimes(1)
  })

  it('runDelete removes items locally and moves primary to next item without calling fetchGallery', async () => {
    const items = [makeItem(1), makeItem(2), makeItem(3)]
    mockApi.fetchGallery.mockResolvedValue({ items })
    mockApi.fetchImageDetail.mockImplementation(async (id: number) =>
      makeDetail(items.find((i) => i.imageId === id) ?? items[0])
    )
    mockApi.deleteImages.mockResolvedValue({ batchId: 42, images: 1, skipped: 0 })
    mockApi.undoDelete.mockResolvedValue(undefined)

    const gallery = useGalleryStore()
    await gallery.load()
    gallery.selectOne(2)
    vi.clearAllMocks()

    await gallery.runDelete([2])
    expect(gallery.items.map((i) => i.imageId)).toEqual([1, 3])
    expect(gallery.primary).toBe(3)
    expect(gallery.selected).toEqual([3])
    expect(mockApi.fetchGallery).not.toHaveBeenCalled()
    expect(mockApi.fetchLibraryOverview).toHaveBeenCalledTimes(1)
    expect(mockApi.fetchTagCatalog).toHaveBeenCalledTimes(1)

    // Undo restores via afterEdit()
    vi.clearAllMocks()
    await useToastStore().undo()
    expect(mockApi.undoDelete).toHaveBeenCalledWith(42)
    expect(mockApi.fetchGallery).toHaveBeenCalledTimes(1)
  })

  it('selectedSet derives an O(1) ReadonlySet matching selected and powers isSelected', async () => {
    const items = [makeItem(1), makeItem(2), makeItem(3), makeItem(4)]
    mockApi.fetchGallery.mockResolvedValue({ items })
    mockApi.fetchImageDetail.mockImplementation(async (id: number) =>
      makeDetail(items.find((i) => i.imageId === id) ?? items[0])
    )

    const gallery = useGalleryStore()
    expect(gallery.selectedSet.size).toBe(0)
    expect(gallery.isSelected(1)).toBe(false)

    await gallery.load()
    expect([...gallery.selectedSet]).toEqual([1])
    expect(gallery.isSelected(1)).toBe(true)
    expect(gallery.isSelected(2)).toBe(false)

    gallery.toggle(3)
    expect(gallery.selectedSet).toBeInstanceOf(Set)
    expect([...gallery.selectedSet]).toEqual([1, 3])
    expect(gallery.isSelected(3)).toBe(true)
    expect(gallery.isSelected(2)).toBe(false)

    gallery.selectRange(4)
    expect([...gallery.selectedSet]).toEqual([3, 4])
    expect(gallery.isSelected(1)).toBe(false)
    expect(gallery.isSelected(3)).toBe(true)
    expect(gallery.isSelected(4)).toBe(true)

    gallery.setMany([1, 2, 4], 2)
    expect([...gallery.selectedSet]).toEqual([1, 2, 4])
    expect(gallery.isSelected(2)).toBe(true)

    gallery.collapse()
    expect([...gallery.selectedSet]).toEqual([2])
    expect(gallery.isSelected(1)).toBe(false)
    expect(gallery.isSelected(2)).toBe(true)
  })
})
