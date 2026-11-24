import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, watch, type VNode } from 'vue'
import type { GalleryItemVO } from '@shared/api'
import { thumbUrl } from '@/api/gallery'
import { startNativeDrag } from '@/api/files'
import { hasInteractiveModal } from '@/components/dialogs/modal'
import { useGalleryStore } from '@/stores/gallery'
import { useToastStore } from '@/stores/toast'
import { useSettingsStore } from '@/stores/settings'
import { useViewerStore } from '@/stores/viewer'
import { useViewStore } from '@/stores/view'
import { useSuggestStore } from '@/stores/suggest'
import { fluidGalleryRows, groupConsecutive, TILE_CHROME, ROW_INSET, monthKey, monthLabel, TILE_GAP } from '@/utils/gridLayout'
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
  rows: ReturnType<typeof fluidGalleryRows>
  // 只在“AI 建议”视图：目标类目录（null 是没有这类建议的那组）、目录还不存在
  aiDir?: { name: string | null; isNew: boolean }
}

// 网格右侧给自绘滚动条留的窄边（和 ImageGrid.scss 的 padding-right 一致）和每行左右的内边距
const GRID_PAD_RIGHT = 14

// 图片网格：按月分组、等高行排版、多选、键盘移动和缩放。
export default defineComponent({
  name: 'ImageGrid',
  components: { GridScrollbar, GridRow },
  setup() {
    const gallery = useGalleryStore()
    const toast = useToastStore()
    const settings = useSettingsStore()
    const viewer = useViewerStore()
    const viewStore = useViewStore()
    const suggest = useSuggestStore()
    const gridRef = ref<HTMLElement | null>(null)
    const galleryWidth = ref(0)

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
      return partitions.value.map(({ items, ...group }) => ({
        ...group, rows: fluidGalleryRows(items, fullWidth, gallery.rowHeight)
      }))
    })

    // 大图库给每行保留准确的高度，只在视口附近挂载卡片。所有行共用一个观察器。
    const virtual = computed(() => gallery.items.length > 200)
    const visibleRows = shallowReactive(new Set<string>())
    let rowObserver: IntersectionObserver | undefined
    const mountRow = ({ el }: VNode): void => {
      rowObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const row = entry.target as HTMLElement
          if (!row.isConnected) continue
          const key = row.dataset.rowKey!
          if (entry.isIntersecting) visibleRows.add(key)
          else visibleRows.delete(key)
        }
      }, { root: gridRef.value, rootMargin: '600px 0px' })
      rowObserver.observe(el as HTMLElement)
    }
    const unmountRow = ({ el }: VNode): void => {
      const row = el as HTMLElement
      rowObserver?.unobserve(row)
      visibleRows.delete(row.dataset.rowKey!)
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
          return
        }
        // Home、End 和大图返回可以跨过尚未渲染的卡片，先定位它所属的行。
        for (const group of groups.value) {
          const row = group.rows.find((r) => r.tiles.some((t) => t.id === id))
          if (row) {
            grid.querySelector(`[data-first-id="${row.tiles[0].id}"]`)?.scrollIntoView({ block: 'nearest' })
            return
          }
        }
      })
    }

    // ↑ / ↓：跳到上一行或下一行里水平位置最近的那张
    const verticalNeighbor = (id: number, dir: -1 | 1): number | null => {
      const rows = groups.value.flatMap(g => g.rows)
      const centers = rows.map((r) => {
        let x = 0
        return r.tiles.map((t) => {
          const c = { id: t.id, x: x + t.width / 2 }
          x += t.width + TILE_GAP
          return c
        })
      })
      const ri = centers.findIndex((r) => r.some((c) => c.id === id))
      const target = centers[ri + dir]
      if (ri < 0 || !target) {
        return null
      }
      const x = centers[ri].find((c) => c.id === id)?.x ?? 0
      return target.reduce((best, c) => (Math.abs(c.x - x) < Math.abs(best.x - x) ? c : best)).id
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

    let observer: ResizeObserver | null = null
    onMounted(() => {
      const container = gridRef.value?.closest('.gallery--main')
      if (container) {
        galleryWidth.value = container.clientWidth
        observer = new ResizeObserver(() => { galleryWidth.value = container.clientWidth })
        observer.observe(container)
      }
      window.addEventListener('keydown', onKey)
    })
    onBeforeUnmount(() => {
      rowObserver?.disconnect()
      observer?.disconnect()
      window.removeEventListener('keydown', onKey)
    })

    // 换视图或重新查询后回到顶部
    watch(
      () => gallery.queryKey,
      () => {
        gridRef.value?.scrollTo({ top: 0 })
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

    return { gallery, viewer, suggest, gridRef, groups, virtual, visibleRows, mountRow, unmountRow, item, masked, thumbUrl, onTileClick, onTileDown, onGridMove, onDragStart, onWheel }
  }
})
