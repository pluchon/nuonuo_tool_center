import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GalleryItemVO } from '@shared/api'
import { thumbUrl } from '@/api/gallery'
import { startNativeDrag } from '@/api/files'
import { hasInteractiveModal } from '@/components/dialogs/modal'
import { useGalleryStore } from '@/stores/gallery'
import { useLookStore } from '@/stores/look'
import { useToastStore } from '@/stores/toast'
import { useSettingsStore } from '@/stores/settings'
import { useViewerStore } from '@/stores/viewer'
import { useViewStore } from '@/stores/view'
import { useSuggestStore } from '@/stores/suggest'
import {
  binarySearchVisibleRows,
  computeVirtualRows,
  fluidGalleryRows,
  groupConsecutive,
  monthKey,
  monthLabel,
  ROW_INSET,
  TILE_CHROME,
  TILE_GAP,
  type LayoutTile,
  type VirtualRowGeometry
} from '@/utils/gridLayout'
import GridScrollbar from './GridScrollbar.vue'
import GridRow from './GridRow.vue'

// 按住多久再拖算系统原生拖拽（毫秒）
export const LONG_PRESS_MS = 400

// 一个月份分组（不分组时只有一组，没有标题）；“AI 建议”视图里按建议放进的类目录分组
export interface GridGroup {
  key: string
  timeline: boolean
  label: string
  ids: number[]
  allOn: boolean
  rows: VirtualRowGeometry[]
  canvasHeightPx: number
  // 只在“AI 建议”视图：目标类目录（null 是没有这类建议的那组）、目录还不存在
  aiDir?: { name: string | null; isNew: boolean }
}

export interface FlatRow {
  flatIndex: number
  groupIndex: number
  rowIndex: number
  firstId: number
  tiles: LayoutTile[]
  imageHeight: string
  offsetInGroup: number
  top: number
  height: number
}

// 网格右侧给自绘滚动条留的窄边（和 ImageGrid.scss 的 padding-right / padding-bottom 一致）
const GRID_PAD_RIGHT = 14
const GRID_PAD_BOTTOM = 18
const OVERSCAN_PX = 600

// 图片网格：按月分组、等高行排版、多选、键盘移动和缩放。
export default defineComponent({
  name: 'ImageGrid',
  components: { GridScrollbar, GridRow },
  setup() {
    const gallery = useGalleryStore()
    const look = useLookStore()
    const toast = useToastStore()
    const settings = useSettingsStore()
    const viewer = useViewerStore()
    const viewStore = useViewStore()
    const suggest = useSuggestStore()
    const aiView = computed(() => viewStore.page === 'gallery' && viewStore.view === 'ai')
    const gridRef = ref<HTMLElement | null>(null)
    const galleryWidth = ref(0)
    const gridContentWidth = ref(0)
    const viewportHeight = ref(0)
    const scrollTop = ref(0)
    const canvasOffsets = ref<number[]>([])
    const monthOffsets = ref<Array<{ top: number; label: string }>>([])
    const totalLayoutHeight = ref(0)

    const byId = computed(() => new Map(gallery.items.map((i) => [i.imageId, i])))
    const item = (id: number): GalleryItemVO => byId.value.get(id) as GalleryItemVO
    // R-18 图在网格里遮挡（设置里可以关掉模糊）
    const masked = (id: number): boolean => item(id).isR18 && settings.values.r18Blur

    // 按导入月份或拍摄月份分组；按大小、名称排序时不分组
    const partitions = computed(() => {
      const sort = gallery.nameOnly ? 'new' : gallery.sort
      // “AI 建议”视图：主进程已经按目标类目录排在一起，这里按目录分组（有这类建议时才分）
      const aiView = viewStore.page === 'gallery' && viewStore.view === 'ai'
      const byDir = aiView && gallery.items.some((i) => i.aiDir)
      const timeline = !aiView && settings.values.groupByMonth && (sort === 'new' || sort === 'old' || sort === 'taken')
      const keyOf = (i: GalleryItemVO): string => (sort === 'taken' ? monthKey(i.takenAt) : monthKey(i.importedAt))
      const parts = byDir
        ? groupConsecutive(gallery.items, (i) => (i.aiDir ? `dir:${i.aiDir.name}` : 'dir:'))
        : timeline
          ? groupConsecutive(gallery.items, keyOf)
          : [{ key: 'all', items: gallery.items }]
      const ratioOf = (i: GalleryItemVO): number => (i.width && i.height ? i.width / i.height : 1)
      return parts.map((p) => {
        const ids = p.items.map((i) => i.imageId)
        const dir = byDir ? (p.items[0].aiDir ?? null) : undefined
        return {
          key: p.key,
          timeline,
          label: byDir ? (dir?.name ?? '其他建议') : monthLabel(p.key),
          ids,
          allOn: gallery.multi && ids.every((id) => gallery.isSelected(id)),
          items: p.items.map((i) => ({ id: i.imageId, ratio: ratioOf(i) })),
          aiDir: dir === undefined ? undefined : { name: dir?.name ?? null, isNew: dir?.isNew ?? false }
        }
      })
    })

    const groups = computed<GridGroup[]>(() => {
      const fullWidth = galleryWidth.value - GRID_PAD_RIGHT - ROW_INSET * 2
      if (fullWidth <= TILE_CHROME) return []
      const contentW = gridContentWidth.value > 0 ? gridContentWidth.value : fullWidth
      return partitions.value.map(({ items, ...group }) => {
        const fluid = fluidGalleryRows(items, fullWidth, gallery.rowHeight)
        const layout = computeVirtualRows(fluid, contentW, fullWidth, gallery.rowHeight)
        return { ...group, rows: layout.rows, canvasHeightPx: layout.canvasHeightPx }
      })
    })

    const flatLayout = computed(() => {
      const flat: FlatRow[] = []
      const byTileId = new Map<number, FlatRow>()
      const bounds: Array<{ start: number; end: number }> = []
      const offsets = canvasOffsets.value
      const gs = groups.value
      for (let gi = 0; gi < gs.length; gi++) {
        const g = gs[gi]
        const canvasTop = offsets[gi] ?? 0
        const start = flat.length
        for (let ri = 0; ri < g.rows.length; ri++) {
          const vr = g.rows[ri]
          const entry: FlatRow = {
            flatIndex: flat.length,
            groupIndex: gi,
            rowIndex: ri,
            firstId: vr.row.tiles[0].id,
            tiles: vr.row.tiles,
            imageHeight: vr.row.imageHeight,
            offsetInGroup: vr.offsetInGroup,
            top: canvasTop + vr.offsetInGroup,
            height: vr.rowHeightPx
          }
          flat.push(entry)
          for (const t of vr.row.tiles) {
            byTileId.set(t.id, entry)
          }
        }
        bounds.push({ start, end: flat.length })
      }
      return { flat, byTileId, bounds }
    })

    const visibleRange = computed(() =>
      binarySearchVisibleRows(flatLayout.value.flat, scrollTop.value, viewportHeight.value, OVERSCAN_PX)
    )

    const visibleRowsByGroup = computed(() => {
      const { flat, bounds } = flatLayout.value
      const { start, end } = visibleRange.value
      const result: FlatRow[][] = bounds.map(() => [])
      if (start >= end) {
        return result
      }
      for (let gi = 0; gi < bounds.length; gi++) {
        const b = bounds[gi]
        const lo = Math.max(b.start, start)
        const hi = Math.min(b.end, end)
        if (lo < hi) {
          result[gi] = flat.slice(lo, hi)
        }
      }
      return result
    })

    // 窗口宽度或缩放档位变化时锚住当前视口顶部那一行，避免虚拟绝对定位下滚偏
    let pendingAnchor: { firstId: number; frac: number } | null = null
    const captureAnchor = (el: HTMLElement): void => {
      if (pendingAnchor || el.scrollTop <= 1 || flatLayout.value.flat.length === 0) {
        return
      }
      const { start } = binarySearchVisibleRows(flatLayout.value.flat, el.scrollTop, 1, 0)
      const row = flatLayout.value.flat[Math.min(start, flatLayout.value.flat.length - 1)]
      if (!row) {
        return
      }
      pendingAnchor = {
        firstId: row.firstId,
        frac: row.height > 0 ? Math.max(0, (el.scrollTop - row.top) / row.height) : 0
      }
    }

    const syncWindow = (knownScrollTop?: number): void => {
      const el = gridRef.value
      if (!el) return
      scrollTop.value = knownScrollTop ?? el.scrollTop
    }

    const measureOffsets = (): void => {
      const grid = gridRef.value
      const gs = groups.value
      if (!grid || gs.length === 0) {
        canvasOffsets.value = []
        monthOffsets.value = []
        totalLayoutHeight.value = 0
        pendingAnchor = null
        return
      }
      const sections = grid.children
      const nextCanvas: number[] = []
      const nextMonths: Array<{ top: number; label: string }> = []
      for (let i = 0; i < gs.length; i++) {
        const section = sections[i] as HTMLElement | undefined
        const canvas = section?.querySelector<HTMLElement>('.image-grid__canvas')
        nextCanvas.push(canvas ? canvas.offsetTop : 0)
        if (gs[i].timeline && section) {
          nextMonths.push({ top: section.offsetTop, label: gs[i].label })
        }
      }
      canvasOffsets.value = nextCanvas
      monthOffsets.value = nextMonths
      const lastIdx = gs.length - 1
      totalLayoutHeight.value = nextCanvas[lastIdx] + gs[lastIdx].canvasHeightPx + GRID_PAD_BOTTOM
      if (pendingAnchor) {
        const anchor = pendingAnchor
        pendingAnchor = null
        const row = flatLayout.value.byTileId.get(anchor.firstId)
        if (row) {
          const target = Math.max(0, row.top + anchor.frac * row.height)
          grid.scrollTop = target
          scrollTop.value = grid.scrollTop
        }
      }
    }

    let scrollRaf = 0
    const onScroll = (): void => {
      if (scrollRaf) return
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0
        syncWindow()
      })
    }

    // 按下的时间：按住约 0.4 秒再拖是系统原生拖拽（带出原文件到别的软件），直接拖是拖到侧栏源目录
    let pressAt: number | null = null
    let moveAt: number | null = null
    const onTileDown = (event: MouseEvent): void => {
      pressAt = event.button === 0 ? event.timeStamp : null
      moveAt = null
    }
    const onGridMove = (event: MouseEvent): void => {
      if (pressAt !== null && (event.buttons & 1)) moveAt = event.timeStamp
    }

    // 开始拖：跟手的是一个小方块缩略图，多张时角上显示张数（只能拖到侧栏的源目录上）
    const onDragStart = (e: DragEvent, id: number): void => {
      const ids = gallery.startDrag(id)
      // Chromium 的 dragstart 沿用按下时间。采用触发拖动的鼠标移动时间，避免渲染延迟影响判断。
      const longPress = pressAt !== null && (moveAt ?? performance.now()) - pressAt >= LONG_PRESS_MS
      pressAt = null
      if (longPress) {
        e.preventDefault()
        gallery.endDrag()
        const fileIds = ids.map((x) => item(x)).filter((p) => !p.missing && !p.offline).map((p) => p.fileId)
        startNativeDrag(fileIds, item(id).hash).catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err), 'error'))
        return
      }
      if (!e.dataTransfer) {
        return
      }
      e.dataTransfer.effectAllowed = 'copyMove'
      e.dataTransfer.setData('application/x-ltm-images', ids.join(','))
      const ghost = document.createElement('div')
      ghost.className = 'drag-ghost'
      const pic = item(id)
      if (pic.thumb === 'READY') {
        ghost.style.backgroundImage = `url("${thumbUrl(pic.hash)}")`
      }
      if (ids.length > 1) {
        const badge = document.createElement('span')
        badge.className = 'drag-ghost__count'
        badge.textContent = String(ids.length)
        ghost.appendChild(badge)
      }
      document.body.appendChild(ghost)
      e.dataTransfer.setDragImage(ghost, 28, 28)
      // 浏览器截完拖动图后就可以移走
      setTimeout(() => ghost.remove(), 0)
    }

    const onTileClick = (e: MouseEvent, id: number): void => {
      gridRef.value?.focus({ preventScroll: true })
      if (e.shiftKey) {
        gallery.selectRange(id)
      } else if (e.ctrlKey || e.metaKey) {
        gallery.toggle(id)
      } else {
        gallery.selectOne(id)
      }
    }

    // Ctrl + 滚轮换档：往上滚变大、往下滚变小
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) {
        return
      }
      e.preventDefault()
      gallery.zoomBy(e.deltaY < 0 ? -1 : 1)
    }

    // 把某张图滚到看得见的位置：单按一下平滑滚过去，按住不放连续跳时直接到位（平滑滚动会跟不上）
    const reveal = (id: number, smooth = false): void => {
      void nextTick(() => {
        const grid = gridRef.value
        if (!grid) return
        const tile = grid.querySelector(`[data-id="${id}"]`)
        if (tile) {
          tile.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
          syncWindow()
          return
        }
        // Home、End 和大图返回可以跨过尚未渲染的卡片，直接定位到所属行的精确坐标并立即同步窗口。
        const row = flatLayout.value.byTileId.get(id)
        if (!row) return
        const viewH = grid.clientHeight
        const curTop = grid.scrollTop
        let nextTop = curTop
        if (row.top < curTop) {
          nextTop = row.top
        } else if (row.top + row.height > curTop + viewH) {
          nextTop = row.top + row.height - viewH
        }
        if (nextTop !== curTop) {
          grid.scrollTo({ top: nextTop, behavior: 'auto' })
          syncWindow(grid.scrollTop)
        }
      })
    }

    // ↑ / ↓：跳到上一行或下一行里水平位置最近的那张
    const verticalNeighbor = (id: number, dir: -1 | 1): number | null => {
      const current = flatLayout.value.byTileId.get(id)
      if (!current) {
        return null
      }
      const target = flatLayout.value.flat[current.flatIndex + dir]
      if (!target) {
        return null
      }
      const centersOf = (tiles: LayoutTile[]) => {
        let x = 0
        return tiles.map((t) => {
          const c = { id: t.id, x: x + t.width / 2 }
          x += t.width + TILE_GAP
          return c
        })
      }
      const curCenters = centersOf(current.tiles)
      const targetCenters = centersOf(target.tiles)
      const x = curCenters.find((c) => c.id === id)?.x ?? 0
      return targetCenters.reduce((best, c) => (Math.abs(c.x - x) < Math.abs(best.x - x) ? c : best)).id
    }

    // 网格的键盘操作；焦点在输入框里或对话框开着时不处理
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (hasInteractiveModal() || el?.closest('.filter-bar, .filter-chips') || el?.matches('input, textarea, select') || el?.isContentEditable) {
        return
      }
      // Delete：删除选中的图（走确认）
      if (e.key === 'Delete') {
        e.preventDefault()
        gallery.askDelete()
        return
      }
      // Ctrl + C：把选中的这张图复制到剪贴板
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void gallery.copyToClipboard()
        return
      }
      // “AI 建议”视图快审：A 采用选中图的全部建议、X 全部不要，处理完选中移到下一张
      const key = e.key.toLowerCase()
      if (viewStore.page === 'gallery' && viewStore.view === 'ai' && !e.ctrlKey && !e.metaKey && !e.altKey && (key === 'a' || key === 'x')) {
        e.preventDefault()
        void suggest.decide(gallery.targets(), key === 'a')
        return
      }
      const order = gallery.items.map((i) => i.imageId)
      if (order.length === 0) {
        return
      }
      const cur = gallery.primary ?? order[0]
      let next: number | null = null
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const i = order.indexOf(cur)
        next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowLeft' ? -1 : 1)))]
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        next = verticalNeighbor(cur, e.key === 'ArrowUp' ? -1 : 1)
      } else if (e.key === 'Home' || e.key === 'End') {
        // Home / End：跳到第一张、最后一张
        next = e.key === 'Home' ? order[0] : order[order.length - 1]
      } else if (e.key === 'Escape') {
        gallery.collapse()
        return
      } else if (e.key === 'Enter' || e.key === ' ') {
        // Enter / 空格：打开大图（看的是详情面板那张；空格再按一次关掉，像“快速预览”）；焦点在别的按钮上时让按钮自己处理
        if (el && (el.tagName === 'BUTTON' || el.tagName === 'A') && !el.classList.contains('tile')) {
          return
        }
        e.preventDefault()
        viewer.show(cur)
        return
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        gallery.setMany(order, cur)
        return
      } else {
        return
      }
      e.preventDefault()
      if (next !== null) {
        gallery.selectOne(next)
        reveal(next, !e.repeat)
      }
    }

    let containerObserver: ResizeObserver | null = null
    let gridObserver: ResizeObserver | null = null
    onMounted(() => {
      const grid = gridRef.value
      const container = grid?.closest('.gallery--main')
      if (container) {
        galleryWidth.value = container.clientWidth
        containerObserver = new ResizeObserver(() => {
          galleryWidth.value = container.clientWidth
        })
        containerObserver.observe(container)
      }
      if (grid) {
        gridContentWidth.value = Math.max(0, grid.clientWidth - GRID_PAD_RIGHT)
        viewportHeight.value = grid.clientHeight
        scrollTop.value = grid.scrollTop
        grid.addEventListener('scroll', onScroll, { passive: true })
        gridObserver = new ResizeObserver(() => {
          const nextW = Math.max(0, grid.clientWidth - GRID_PAD_RIGHT)
          if (nextW !== gridContentWidth.value) {
            captureAnchor(grid)
            gridContentWidth.value = nextW
          }
          viewportHeight.value = grid.clientHeight
        })
        gridObserver.observe(grid)
      }
      window.addEventListener('keydown', onKey)
      void nextTick(measureOffsets)
    })
    onBeforeUnmount(() => {
      gridRef.value?.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(scrollRaf)
      containerObserver?.disconnect()
      gridObserver?.disconnect()
      window.removeEventListener('keydown', onKey)
    })

    watch(() => gallery.rowHeight, () => {
      if (gridRef.value) {
        captureAnchor(gridRef.value)
      }
    }, { flush: 'sync' })

    watch(groups, measureOffsets, { flush: 'post' })

    // 换视图或重新查询后回到顶部
    watch(
      () => gallery.queryKey,
      () => {
        pendingAnchor = null
        gridRef.value?.scrollTo({ top: 0 })
        syncWindow(0)
      }
    )

    // 大图里换了图：关掉后网格停在最后看的那张
    watch(
      () => viewer.open,
      (open) => {
        if (!open && gallery.primary !== null) {
          reveal(gallery.primary)
        }
      }
    )

    return {
      gallery,
      look,
      aiView,
      viewer,
      suggest,
      gridRef,
      groups,
      visibleRowsByGroup,
      monthOffsets,
      totalLayoutHeight,
      item,
      masked,
      thumbUrl,
      onTileClick,
      onTileDown,
      onGridMove,
      onDragStart,
      onWheel
    }
  }
})
