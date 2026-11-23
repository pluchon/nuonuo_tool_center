import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { openFileWithDefault, originalUrl, thumbUrl } from '@/api/gallery'
import { useToastStore } from '@/stores/toast'
import { useViewerStore } from '@/stores/viewer'
import { actualZoom, canShowOriginal, clampZoom, fitScale, WHEEL_STEP, ZOOM_STEP } from '@/utils/viewerMath'

// 标题最多显示几个字
const TITLE_MAX = 15

// 大图查看（照原型 viewer）：斜纹外框的白卡片，标题 + 关闭；舞台里整张图适应窗口显示，两侧上一张 / 下一张；
// 下面左边缩放（缩小、百分比、放大、适应窗口、原始大小），右边旋转、水平翻转、还原。
// 放大后按住左键拖动平移，Ctrl + 滚轮缩放，缩回 100% 及以下自动回中；← / → 换图，Esc 关闭
export default defineComponent({
  name: 'ImageViewer',
  setup() {
    const viewer = useViewerStore()

    const stageRef = ref<HTMLElement | null>(null)
    const closeRef = ref<HTMLButtonElement | null>(null)
    const stageW = ref(0)
    const stageH = ref(0)
    // 图片本身的像素大小（读到之前先用库里记的宽高）
    const natW = ref(0)
    const natH = ref(0)
    // 原图读不到（文件不见了、目录离线）时退回缩略图
    const originalFailed = ref(false)
    const thumbFailed = ref(false)
    // 当前这张读完了没有：读完之前先垫着缩略图，读完再淡入（换图不闪黑）
    const picReady = ref(false)

    const zoom = ref(100)
    const rot = ref(0)
    const flipped = ref(false)
    const panX = ref(0)
    const panY = ref(0)
    const dragging = ref(false)
    let drag: { x: number; y: number; px: number; py: number } | null = null

    const item = computed(() => viewer.currentItem)
    const multi = computed(() => viewer.items.length > 1)
    const title = computed(() => Array.from(viewer.attachment?.name ?? item.value?.name ?? '').slice(0, TITLE_MAX).join(''))
    // 标题旁的“第几张 / 共几张”
    const position = computed(() => {
      const i = viewer.items.findIndex((x) => x.imageId === viewer.currentId)
      return i < 0 || viewer.items.length < 2 ? '' : `${i + 1} / ${viewer.items.length}`
    })

    // 显示什么：原图 / 缩略图（格式浏览器显示不了，或原图读不到）/ 都没有
    const source = computed<{ kind: 'original' | 'thumb' | 'none'; src: string }>(() => {
      const it = item.value
      if (viewer.attachment) {
        if (!originalFailed.value) return { kind: 'original', src: viewer.attachment.dataUrl }
        if (!thumbFailed.value && viewer.attachment.preview) return { kind: 'thumb', src: viewer.attachment.preview }
      }
      if (!it) {
        return { kind: 'none', src: '' }
      }
      if (canShowOriginal(it.format) && !originalFailed.value) {
        return { kind: 'original', src: originalUrl(it.fileId, it.hash) }
      }
      if (it.thumb === 'READY' && !thumbFailed.value) {
        return { kind: 'thumb', src: thumbUrl(it.hash) }
      }
      return { kind: 'none', src: '' }
    })

    // 原图还没读完时垫在下面的缩略图
    const placeholder = computed(() => {
      const it = item.value
      if (source.value.kind !== 'original' || picReady.value || !it || it.thumb !== 'READY' || thumbFailed.value) {
        return ''
      }
      return thumbUrl(it.hash)
    })

    // 舞台上方的一行说明（只看得到缩略图时）
    const note = computed(() => {
      if (source.value.kind === 'thumb' && viewer.attachment) return '原图无法显示，正在查看预览图'
      if (source.value.kind !== 'thumb' || !item.value) {
        return ''
      }
      return canShowOriginal(item.value.format) ? '原图读不到，先显示缩略图' : `${item.value.format} 只能看缩略图`
    })

    const fit = computed(() => fitScale(natW.value, natH.value, stageW.value, stageH.value, rot.value))

    const picStyle = computed(() => {
      const s = zoom.value / 100
      return {
        width: `${natW.value * fit.value}px`,
        height: `${natH.value * fit.value}px`,
        transform: `translate(${panX.value}px, ${panY.value}px) scale(${s * (flipped.value ? -1 : 1)}, ${s}) rotate(${rot.value}deg)`,
        transition: dragging.value ? 'opacity 0.2s' : 'transform 0.2s, opacity 0.2s'
      }
    })

    // 适应窗口时是放大镜（双击放大），放大后是抓手（拖动）
    const cursor = computed(() => (zoom.value > 100 ? (dragging.value ? 'grabbing' : 'grab') : 'zoom-in'))

    // 换图或重新打开：缩放、旋转、平移都还原
    const resetView = (): void => {
      zoom.value = 100
      rot.value = 0
      flipped.value = false
      panX.value = 0
      panY.value = 0
    }

    // 缩放：anchor 是相对舞台中心的一点（鼠标位置），缩放后图上这一点还在鼠标下面；不给就以舞台中心为准。
    // 图的位置 = 平移 + 缩放×(旋转后的图内坐标)，等比缩放时新平移 = 锚点 − (锚点 − 旧平移)×新旧比例
    const setZoom = (z: number, anchor: { x: number; y: number } = { x: 0, y: 0 }): void => {
      const before = zoom.value
      const after = clampZoom(z, fit.value)
      zoom.value = after
      if (after <= 100) {
        panX.value = 0
        panY.value = 0
        return
      }
      const k = after / before
      panX.value = anchor.x - (anchor.x - panX.value) * k
      panY.value = anchor.y - (anchor.y - panY.value) * k
    }

    const zoomIn = (): void => setZoom(zoom.value + ZOOM_STEP)
    const zoomOut = (): void => setZoom(zoom.value - ZOOM_STEP)
    const fitWindow = (): void => setZoom(100)
    const actual = (): void => setZoom(actualZoom(fit.value))
    const rotL = (): void => {
      rot.value -= 90
    }
    const rotR = (): void => {
      rot.value += 90
    }
    const flip = (): void => {
      flipped.value = !flipped.value
    }

    // 预读前后两张的原图，换图时基本不用等（只留最近的两张引用）
    let preloads: HTMLImageElement[] = []
    const preloadNeighbors = (): void => {
      const list = viewer.items
      const i = list.findIndex((x) => x.imageId === viewer.currentId)
      if (i < 0 || list.length < 2) {
        return
      }
      preloads = [list[(i + 1) % list.length], list[(i - 1 + list.length) % list.length]]
        .filter((x) => canShowOriginal(x.format))
        .map((x) => {
          const img = new Image()
          img.decoding = 'async'
          img.src = originalUrl(x.fileId, x.hash)
          return img
        })
    }

    const onLoad = (e: Event): void => {
      const img = e.target as HTMLImageElement
      picReady.value = true
      if (source.value.kind === 'original') {
        preloadNeighbors()
      }
      // 缩略图只用来定比例：按库里记的原图宽高算大小，和原图一致
      if (source.value.kind === 'original' || !item.value?.width || !item.value?.height) {
        natW.value = img.naturalWidth
        natH.value = img.naturalHeight
      }
    }
    const onError = (): void => {
      picReady.value = false
      if (source.value.kind === 'original') {
        originalFailed.value = true
      } else if (source.value.kind === 'thumb') {
        thumbFailed.value = true
      }
    }

    // Ctrl + 滚轮缩放
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) {
        return
      }
      e.preventDefault()
      // 以鼠标所在的位置为中心缩放
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const anchor = { x: e.clientX - (box.left + box.width / 2), y: e.clientY - (box.top + box.height / 2) }
      setZoom(zoom.value + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP), anchor)
    }

    // 双击：适应窗口和原始大小之间切换（图本身比窗口小时放大到 2 倍），以双击的位置为中心
    const onDblClick = (e: MouseEvent): void => {
      if (zoom.value > 100) {
        setZoom(100)
        return
      }
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const anchor = { x: e.clientX - (box.left + box.width / 2), y: e.clientY - (box.top + box.height / 2) }
      const real = actualZoom(fit.value)
      setZoom(real > 100 ? real : 200, anchor)
    }

    // 放大后按住左键拖动；松手在哪都算
    const onMouseMove = (e: MouseEvent): void => {
      if (drag) {
        panX.value = drag.px + e.clientX - drag.x
        panY.value = drag.py + e.clientY - drag.y
      }
    }
    const onMouseUp = (): void => {
      drag = null
      dragging.value = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (zoom.value <= 100 || e.button !== 0) {
        return
      }
      e.preventDefault()
      drag = { x: e.clientX, y: e.clientY, px: panX.value, py: panY.value }
      dragging.value = true
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    }

    // 点遮罩关闭；在舞台里按下、拖到遮罩上松手不算
    let downOnMask = false
    const onMaskDown = (e: MouseEvent): void => {
      downOnMask = e.target === e.currentTarget
    }
    const onMaskClick = (e: MouseEvent): void => {
      if (downOnMask && e.target === e.currentTarget) {
        viewer.close()
      }
      downOnMask = false
    }

    const onOpenDefault = async (): Promise<void> => {
      if (!item.value) {
        return
      }
      try {
        await openFileWithDefault(item.value.fileId)
      } catch (err) {
        useToastStore().show(err instanceof Error ? err.message : String(err), 'error')
      }
    }

    // 看图软件通行的缩放键：+ / − 缩放，0 适应窗口，1 原始大小
    const ZOOM_KEYS: Record<string, () => void> = { '+': zoomIn, '=': zoomIn, '-': zoomOut, '0': fitWindow, '1': actual }

    // ← / → 换图，Esc 关闭；在捕获阶段处理，网格的快捷键就收不到了
    const onKey = (e: KeyboardEvent): void => {
      if (!viewer.open) {
        return
      }
      const zoomKey = e.ctrlKey || e.altKey || e.metaKey ? undefined : ZOOM_KEYS[e.key]
      if (zoomKey) {
        e.preventDefault()
        e.stopPropagation()
        zoomKey()
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        viewer.step(e.key === 'ArrowLeft' ? -1 : 1)
      } else if (e.key === 'Escape' || e.key === ' ') {
        // Esc 或空格关闭（空格和网格里的空格打开成对，像“快速预览”）
        e.preventDefault()
        e.stopPropagation()
        viewer.close()
      }
    }

    const measure = (): void => {
      stageW.value = stageRef.value?.clientWidth ?? 0
      stageH.value = stageRef.value?.clientHeight ?? 0
    }
    let observer: ResizeObserver | null = null
    watch(stageRef, (el) => {
      observer?.disconnect()
      observer = null
      if (el) {
        measure()
        observer = new ResizeObserver(measure)
        observer.observe(el)
      }
    })

    // 换了一张（或重新打开）：先用库里的宽高，图读到后再换成实际像素
    watch(
      () => viewer.seq,
      async () => {
        resetView()
        picReady.value = false
        originalFailed.value = false
        thumbFailed.value = false
        natW.value = item.value?.width ?? 0
        natH.value = item.value?.height ?? 0
        await nextTick()
        closeRef.value?.focus()
      }
    )

    // 看着的图离开了列表（被删、被移走）就关掉
    watch(item, (it) => {
      if (viewer.open && !viewer.attachment && !it) {
        viewer.close()
      }
    })

    onMounted(() => window.addEventListener('keydown', onKey, true))
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey, true)
      onMouseUp()
      observer?.disconnect()
      preloads = []
    })

    return {
      viewer,
      item,
      multi,
      title,
      position,
      source,
      placeholder,
      picReady,
      note,
      zoom,
      flipped,
      picStyle,
      cursor,
      stageRef,
      closeRef,
      zoomIn,
      zoomOut,
      fitWindow,
      actual,
      rotL,
      rotR,
      flip,
      resetView,
      onLoad,
      onError,
      onWheel,
      onDblClick,
      onMouseDown,
      onMaskDown,
      onMaskClick,
      onOpenDefault
    }
  }
})
