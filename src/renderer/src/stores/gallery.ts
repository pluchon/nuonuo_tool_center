import { defineStore } from 'pinia'
import {
  TAGS_PER_IMAGE,
  type DirKeyDTO,
  type FolderRefDTO,
  type GalleryItemVO,
  type GalleryQueryDTO,
  type ImageDetailVO,
  type ImageTagVO,
  type MoreFilterDTO
} from '@shared/api'
import type { SortKey } from '@shared/settings'
import { addImageTag, fetchCommonTags, removeImageTag, renameImage, setImagesR18 } from '@/api/edit'
import { copyImageToClipboard, deleteImages, undoDelete } from '@/api/files'
import { fetchGallery, fetchImageDetail } from '@/api/gallery'
import { DEFAULT_ZOOM, ROW_HEIGHTS } from '@/utils/gridLayout'
import { useLibraryStore } from './library'
import { useSettingsStore } from './settings'
import { useTagsStore } from './tags'
import { useToastStore } from './toast'
import { useTransferStore } from './transfer'
import { useViewStore } from './view'

// 一次最多选多少张
export const MAX_SELECTION = 200
// 缩略图档位存在本机（每台电脑自己的习惯）
const ZOOM_KEY = 'ltm.zoom'

function readZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY)
    const v = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(v) && v >= 0 && v < ROW_HEIGHTS.length ? v : DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM
  }
}

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 每次查询的序号：只采用最后一次查询的结果
let querySeq = 0
let detailSeq = 0

// 图片网格：查询条件、列表、选中状态、详情、缩略图档位
export const useGalleryStore = defineStore('gallery', {
  state: () => ({
    q: '',
    sort: 'new' as SortKey,
    onlyR18: false,
    onlyHere: false,
    // 标签、目录、更多筛选
    tagIds: [] as number[],
    dirs: [] as DirKeyDTO[],
    more: {} as MoreFilterDTO,
    items: [] as GalleryItemVO[],
    loaded: false,
    loading: false,
    error: '',
    // 选中的图（按选中先后）；primary 是详情面板显示的那张；anchor 是 Shift 连选的起点
    selected: [] as number[],
    primary: null as number | null,
    anchor: null as number | null,
    detail: null as ImageDetailVO | null,
    detailError: '',
    // 多选时的共同标签
    commonTags: [] as ImageTagVO[],
    // 正在拖动的图；拖到哪个源目录上（侧栏行的键）；松手后等确认的拖放
    dragging: [] as number[],
    dropKey: null as string | null,
    dropAsk: null as { ids: number[]; target: string; label: string; move: boolean } | null,
    // 等待确认删除的图（确认框开着时不为空）
    deleteAsk: null as number[] | null,
    deleteBusy: false,
    zoom: readZoom(),
    // 查询条件变了就加一（网格据此回到顶部）；扫描中的刷新条件不变，不加
    queryKey: 0,
    lastQuery: ''
  }),
  getters: {
    // 只按图片名搜、不放排序和 R-18 的视图：源目录、还没打标签、最近导入
    nameOnly(): boolean {
      const v = useViewStore()
      return v.view === 'untagged' || v.view === 'recent' || v.view === 'ai' || (v.view === 'dir' && v.dir?.kind === 'source')
    },
    multi: (s): boolean => s.selected.length >= 2,
    isSelected:
      (s) =>
      (id: number): boolean =>
        s.selected.includes(id),
    primaryItem: (s): GalleryItemVO | undefined => s.items.find((i) => i.imageId === s.primary),
    rowHeight: (s): number => ROW_HEIGHTS[s.zoom]
  },
  actions: {
    // 当前视图和条件对应的查询
    query(): GalleryQueryDTO | null {
      const v = useViewStore()
      const base = { q: this.q, sort: this.nameOnly ? 'new' : this.sort } as const
      // 筛选条件是响应式代理，IPC 只能传普通对象（代理无法结构化克隆），这里拷一份
      const tagIds = [...this.tagIds]
      const dirs = this.dirs.map((d) => ({ ...d }))
      const more = JSON.parse(JSON.stringify(this.more)) as MoreFilterDTO
      if (v.view === 'dir') {
        if (!v.dir) {
          return null
        }
        return v.dir.kind === 'source'
          ? { ...base, view: 'source', sourceId: v.dir.id, sub: v.dir.sub ?? '', onlyHere: this.onlyHere }
          : { ...base, view: 'category', category: v.dir.name, onlyHere: this.onlyHere, onlyR18: this.onlyR18, tagIds, more }
      }
      if (v.view === 'all' || v.view === 'r18') {
        return { ...base, view: v.view, onlyR18: v.view === 'all' && this.onlyR18, tagIds, dirs, more }
      }
      return { ...base, view: v.view, dirs: v.view === 'untagged' ? dirs : undefined }
    },
    // 切换视图时清掉搜索、筛选和只看开关，排序回到设置里的默认排序
    resetFilters(): void {
      this.q = ''
      this.onlyR18 = false
      this.onlyHere = false
      this.tagIds = useViewStore().takePresetTags()
      this.dirs = []
      this.more = {}
      this.sort = useSettingsStore().values.defaultSort
    },
    // 按当前条件重新查；保留还在列表里的选中，否则选第一张
    async load(): Promise<void> {
      const query = this.query()
      if (!query) {
        return
      }
      const seq = ++querySeq
      this.loading = true
      // 选中的那张在旧列表里的位置：它离开列表时（比如在“R-18 图”里取消 R-18）选同一位置上的下一张
      const oldIndex = this.primary === null ? -1 : this.items.findIndex((i) => i.imageId === this.primary)
      try {
        const { items } = await fetchGallery(query)
        if (seq !== querySeq) {
          return
        }
        this.items = items
        this.error = ''
        this.loaded = true
        const key = JSON.stringify(query)
        if (key !== this.lastQuery) {
          this.lastQuery = key
          this.queryKey += 1
        }
        const ids = new Set(items.map((i) => i.imageId))
        const kept = this.selected.filter((id) => ids.has(id))
        if (kept.length > 0) {
          this.selected = kept
          if (this.primary === null || !ids.has(this.primary)) {
            this.primary = kept[0]
          }
        } else {
          const at = oldIndex >= 0 ? Math.min(oldIndex, items.length - 1) : 0
          this.selectOne(items[at]?.imageId ?? null)
        }
        void this.loadDetail()
      } catch (err) {
        if (seq === querySeq) {
          this.error = errText(err)
          this.loaded = true
          // 列表里还留着上一次的图时，不能悄悄显示旧结果：提示出来
          if (this.items.length > 0) {
            useToastStore().show(`图片列表没刷新：${this.error}`, 'error')
          }
        }
      } finally {
        if (seq === querySeq) {
          this.loading = false
        }
      }
    },
    // 读详情面板要显示的那张
    async loadDetail(): Promise<void> {
      const id = this.multi ? null : this.primary
      const seq = ++detailSeq
      if (id === null) {
        this.detail = null
        if (this.multi) {
          const ids = [...this.selected]
          try {
            const common = await fetchCommonTags(ids)
            if (seq === detailSeq) {
              this.commonTags = common
            }
          } catch (err) {
            if (seq === detailSeq) {
              this.commonTags = []
              this.detailError = err instanceof Error ? err.message : String(err)
            }
          }
        }
        return
      }
      try {
        const detail = await fetchImageDetail(id)
        if (seq === detailSeq) {
          this.detail = detail
          this.detailError = ''
        }
      } catch (err) {
        if (seq === detailSeq) {
          this.detail = null
          this.detailError = err instanceof Error ? err.message : String(err)
        }
      }
    },
    // 普通点击：只选这一张
    selectOne(id: number | null): void {
      this.selected = id === null ? [] : [id]
      this.primary = id
      this.anchor = id
      void this.loadDetail()
    },
    // Ctrl 点击（或点勾选圈）：加选或取消这一张；剩一张时回到单选
    toggle(id: number): void {
      if (this.selected.includes(id)) {
        const rest = this.selected.filter((x) => x !== id)
        if (rest.length === 0) {
          return
        }
        this.selected = rest
        if (this.primary === id) {
          this.primary = rest[rest.length - 1]
        }
      } else {
        if (this.selected.length >= MAX_SELECTION) {
          useToastStore().show(`一次最多选 ${MAX_SELECTION} 张`, 'error')
          return
        }
        this.selected = [...this.selected, id]
        this.primary = id
      }
      this.anchor = id
      void this.loadDetail()
    },
    // Shift 点击：从起点到这一张按当前顺序连选
    selectRange(id: number): void {
      const order = this.items.map((i) => i.imageId)
      const from = order.indexOf(this.anchor ?? id)
      const to = order.indexOf(id)
      if (from < 0 || to < 0) {
        this.selectOne(id)
        return
      }
      const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
      this.setMany(from <= to ? range : range.reverse(), id)
    },
    // 选中一批（Ctrl + A、选择本月）；超过上限时只取前 200 张并提示
    setMany(ids: number[], primary?: number): void {
      if (ids.length > MAX_SELECTION) {
        useToastStore().show(`一次最多选 ${MAX_SELECTION} 张`, 'error')
      }
      const picked = ids.slice(0, MAX_SELECTION)
      if (picked.length === 0) {
        return
      }
      this.selected = picked
      this.primary = primary !== undefined && picked.includes(primary) ? primary : picked[0]
      void this.loadDetail()
    },
    // 选择本月 / 取消选择本月
    toggleGroup(ids: number[]): void {
      const allOn = ids.every((id) => this.selected.includes(id))
      if (allOn) {
        const rest = this.selected.filter((id) => !ids.includes(id))
        if (rest.length === 0) {
          this.selectOne(ids[0])
        } else {
          this.selected = rest
          this.primary = rest.includes(this.primary ?? -1) ? this.primary : rest[0]
          void this.loadDetail()
        }
        return
      }
      const base = this.multi ? this.selected : []
      this.setMany([...new Set([...base, ...ids])], ids[0])
    },
    // Esc：回到单选
    collapse(): void {
      if (this.multi) {
        this.selectOne(this.primary)
      }
    },
    // 改完之后刷新：列表（名字、是否打过标签、是否还在这个视图里）、详情、侧栏计数、标签字典
    async afterEdit(): Promise<void> {
      await Promise.all([this.load(), useLibraryStore().load(), useTagsStore().load()])
    },
    // 当前要改的图：多选时是全部选中的，否则是正在看的那张
    targets(): number[] {
      return this.multi ? [...this.selected] : this.primary === null ? [] : [this.primary]
    },
    // 改名字；失败时提示并保留原名
    async rename(name: string): Promise<boolean> {
      const id = this.primary
      if (id === null || this.multi) {
        return false
      }
      try {
        await renameImage(id, name)
        await this.afterEdit()
        return true
      } catch (err) {
        useToastStore().show(errText(err), 'error')
        return false
      }
    },
    // 标记 / 取消 R-18（单张或多选）
    async setR18(value: boolean): Promise<void> {
      const ids = this.targets()
      if (ids.length === 0) {
        return
      }
      try {
        await setImagesR18(ids, value)
        await this.afterEdit()
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    // 加标签（单张或多选）；多选时有图已满 5 个就提示跳过了几张
    async addTag(name: string, categoryId?: number): Promise<boolean> {
      const ids = this.targets()
      if (ids.length === 0 || !name.trim()) {
        return false
      }
      try {
        const result = await addImageTag({ imageIds: ids, name, categoryId })
        if (result.skipped > 0) {
          useToastStore().show(`有 ${result.skipped} 张已经有 ${TAGS_PER_IMAGE} 个标签了，没加上`, 'error')
        }
        await this.afterEdit()
        return true
      } catch (err) {
        useToastStore().show(errText(err), 'error')
        return false
      }
    },
    // 移除标签（单张或多选）
    async removeTag(tagId: number): Promise<void> {
      const ids = this.targets()
      if (ids.length === 0) {
        return
      }
      try {
        await removeImageTag(ids, tagId)
        await this.afterEdit()
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    // 删除当前要改的图：设置里开了“删除前确认”就先弹确认框
    askDelete(): void {
      const ids = this.targets()
      if (ids.length === 0) {
        return
      }
      if (useSettingsStore().values.confirmDelete) {
        this.deleteAsk = ids
      } else {
        void this.runDelete(ids)
      }
    },
    cancelDelete(): void {
      this.deleteAsk = null
    },
    async confirmDelete(): Promise<void> {
      const ids = this.deleteAsk
      if (!ids || this.deleteBusy) {
        return
      }
      this.deleteBusy = true
      await this.runDelete(ids)
      this.deleteBusy = false
      this.deleteAsk = null
    },
    // 删除：图马上从列表里消失（选中移到同一位置上的下一张），提示条上可以撤销
    async runDelete(ids: number[]): Promise<void> {
      const query = this.query()
      if (!query) {
        return
      }
      const toast = useToastStore()
      try {
        // ids 可能来自响应式状态（确认框里存的那份），IPC 只能传普通数组
        const res = await deleteImages(query, [...ids])
        await this.afterEdit()
        const text = res.images === 1 ? '已放进系统回收站' : `${res.images} 张图已放进系统回收站`
        toast.show(text, 'ok', async () => {
          try {
            await undoDelete(res.batchId)
            await this.afterEdit()
          } catch (err) {
            toast.show(errText(err), 'error')
          }
        })
      } catch (err) {
        toast.show(errText(err), 'error')
      }
    },
    // Ctrl + C：单张时把图复制到剪贴板；多选时系统剪贴板放不了多张图，提示一下
    async copyToClipboard(): Promise<void> {
      const toast = useToastStore()
      if (this.multi) {
        toast.show('一次只能复制一张图，多张请用“复制到…”', 'error')
        return
      }
      const fileId = this.primaryItem?.fileId
      if (fileId === undefined) {
        return
      }
      try {
        await copyImageToClipboard(fileId)
        toast.show('已复制图片')
      } catch (err) {
        toast.show(errText(err), 'error')
      }
    },
    // 开始拖：拖的是选中的那组（按住的图在选中里），否则只拖这一张
    startDrag(id: number): number[] {
      this.dragging = this.selected.includes(id) ? [...this.selected] : [id]
      return this.dragging
    },
    endDrag(): void {
      this.dragging = []
      this.dropKey = null
    },
    // 松手：弹确认（复制或移动 N 张到这个源目录）
    askDrop(ref: FolderRefDTO, label: string, move: boolean): void {
      const ids = [...this.dragging]
      this.endDrag()
      if (ref.kind !== 'source' || ids.length === 0) {
        return
      }
      const root = useLibraryStore().overview?.sources.find((s) => s.id === ref.id)
      if (!root) {
        return
      }
      this.dropAsk = { ids, target: ref.sub ? `${root.path}\\${ref.sub}` : root.path, label, move }
    },
    cancelDrop(): void {
      this.dropAsk = null
    },
    // 确认拖放：和“复制到 / 移动到”走同一套
    async confirmDrop(): Promise<void> {
      const ask = this.dropAsk
      const query = this.query()
      if (!ask || !query || this.deleteBusy) {
        return
      }
      this.deleteBusy = true
      try {
        await useTransferStore().runDirect(ask.move ? 'move' : 'copy', query, ask.ids, [ask.target])
      } finally {
        this.deleteBusy = false
        this.dropAsk = null
      }
    },
    // 缩略图换档（delta 为正变小、为负变大）
    zoomBy(delta: number): void {
      const next = Math.min(ROW_HEIGHTS.length - 1, Math.max(0, this.zoom + delta))
      if (next === this.zoom) {
        return
      }
      this.zoom = next
      try {
        localStorage.setItem(ZOOM_KEY, String(next))
      } catch {
        // 存不下只是下次回到默认档
      }
    }
  }
})
