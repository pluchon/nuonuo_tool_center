import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GalleryItemVO } from '@shared/api'
import { thumbUrl } from '@/api/gallery'
import { useGalleryStore } from '@/stores/gallery'
import { useSettingsStore } from '@/stores/settings'
import { useTransferStore } from '@/stores/transfer'
import { useViewerStore } from '@/stores/viewer'
import { groupConsecutive, layoutRows, monthKey, monthLabel, TILE_GAP, type LayoutRow } from '@/utils/gridLayout'

// 一个月份分组（不分组时只有一组，没有标题）
export interface GridGroup {
  key: string
  timeline: boolean
  label: string
  ids: number[]
  allOn: boolean
  rows: LayoutRow[]
}

// 网格右侧留白和每行左右的内边距（照原型）
const GRID_PAD_RIGHT = 2
const ROW_PAD_X = 2

// 图片网格：按月分组、固定行高排版、单选 / Ctrl / Shift 多选、键盘移动、Ctrl + 滚轮换档
export default defineComponent({
  name: 'ImageGrid',
  setup() {
    const gallery = useGalleryStore()
    const settings = useSettingsStore()
    const viewer = useViewerStore()
    const transfer = useTransferStore()
    const gridRef = ref<HTMLElement | null>(null)
    const width = ref(0)

    const byId = computed(() => new Map(gallery.items.map((i) => [i.imageId, i])))
    const item = (id: number): GalleryItemVO => byId.value.get(id) as GalleryItemVO
    // R-18 图在网格里遮挡（设置里可以关掉模糊）
    const masked = (id: number): boolean => item(id).isR18 && settings.values.r18Blur

    // 按导入月份或拍摄月份分组；按大小、名称排序时不分组
    const groups = computed<GridGroup[]>(() => {
      const rowWidth = width.value - GRID_PAD_RIGHT - ROW_PAD_X * 2
      if (rowWidth <= 0) {
        return []
      }
      const sort = gallery.nameOnly ? 'new' : gallery.sort
      const timeline = settings.values.groupByMonth && (sort === 'new' || sort === 'old' || sort === 'taken')
      const keyOf = (i: GalleryItemVO): string => (sort === 'taken' ? monthKey(i.takenAt) : monthKey(i.importedAt))
      const parts = timeline ? groupConsecutive(gallery.items, keyOf) : [{ key: 'all', items: gallery.items }]
      const ratioOf = (i: GalleryItemVO): number => (i.width && i.height ? i.width / i.height : 1)
      return parts.map((p) => {
        const ids = p.items.map((i) => i.imageId)
        return {
          key: p.key,
          timeline,
          label: monthLabel(p.key),
          ids,
          allOn: gallery.multi && ids.every((id) => gallery.isSelected(id)),
          rows: layoutRows(
            p.items.map((i) => ({ id: i.imageId, ratio: ratioOf(i) })),
            rowWidth,
            gallery.rowHeight
          )
        }
      })
    })

    // 行很多时让浏览器跳过屏幕外的行（缩略图本身也是懒加载）
    const rowStyle = computed(() => ({ containIntrinsicSize: `auto ${gallery.rowHeight + 40}px` }))

    // 开始拖：跟手的是一个小方块缩略图，多张时角上显示张数（只能拖到侧栏的源目录上）
    const onDragStart = (e: DragEvent, id: number): void => {
      const ids = gallery.startDrag(id)
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
        gridRef.value?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
      })
    }

    // ↑ / ↓：跳到上一行或下一行里水平位置最近的那张
    const verticalNeighbor = (id: number, dir: -1 | 1): number | null => {
      const rows = groups.value.flatMap((g) => g.rows)
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
      if (viewer.open || settings.dialogOpen || gallery.deleteAsk || transfer.mode || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))) {
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
      if (gridRef.value) {
        width.value = gridRef.value.clientWidth
        observer = new ResizeObserver(() => {
          width.value = gridRef.value?.clientWidth ?? 0
        })
        observer.observe(gridRef.value)
      }
      window.addEventListener('keydown', onKey)
    })
    onBeforeUnmount(() => {
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

    return { gallery, viewer, gridRef, groups, rowStyle, item, masked, thumbUrl, onTileClick, onDragStart, onWheel }
  }
})
