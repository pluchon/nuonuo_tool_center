import { defineStore } from 'pinia'
import type { GalleryItemVO, GalleryQueryDTO, ImageDetailVO } from '@shared/api'
import type { SortKey } from '@shared/settings'
import { fetchGallery, fetchImageDetail } from '@/api/gallery'
import { DEFAULT_ZOOM, ROW_HEIGHTS } from '@/utils/gridLayout'
import { useSettingsStore } from './settings'
import { useToastStore } from './toast'
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
    zoom: readZoom(),
    // 查询条件变了就加一（网格据此回到顶部）；扫描中的刷新条件不变，不加
    queryKey: 0,
    lastQuery: ''
  }),
  getters: {
    // 只按图片名搜、不放排序和 R-18 的视图：源目录、还没打标签、最近导入
    nameOnly(): boolean {
      const v = useViewStore()
      return v.view === 'untagged' || v.view === 'recent' || (v.view === 'dir' && v.dir?.kind === 'source')
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
      if (v.view === 'dir') {
        if (!v.dir) {
          return null
        }
        return v.dir.kind === 'source'
          ? { ...base, view: 'source', sourceId: v.dir.id, onlyHere: this.onlyHere }
          : { ...base, view: 'category', category: v.dir.name, onlyHere: this.onlyHere, onlyR18: this.onlyR18 }
      }
      return { ...base, view: v.view, onlyR18: v.view === 'all' && this.onlyR18 }
    },
    // 切换视图时清掉搜索和只看开关，排序回到设置里的默认排序
    resetFilters(): void {
      this.q = ''
      this.onlyR18 = false
      this.onlyHere = false
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
          this.selectOne(items[0]?.imageId ?? null)
        }
        void this.loadDetail()
      } catch (err) {
        if (seq === querySeq) {
          this.error = err instanceof Error ? err.message : String(err)
          this.loaded = true
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
