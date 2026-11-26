import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { findMonthAtOffset, monthLabel } from '@/utils/gridLayout'

// 滑块最短多高、轨道上下各留多少
const MIN_THUMB = 36
const INSET = 6
// 停止滚动后多久收起（滑块变回半透明、月份气泡消失）
const IDLE_MS = 900

// 图片网格右侧的自绘滚动条：主题色渐变滑块，可拖、可点轨道跳转；按月分组时拖动或滚动会在旁边显示当前月份
export default defineComponent({
  name: 'GridScrollbar',
  props: {
    // 要控制的滚动容器
    target: { type: Object as PropType<HTMLElement | null>, default: null },
    // 是否按月分组（分组时才显示月份气泡）
    timeline: { type: Boolean, default: false },
    // 内容变了（换档、增删图）时由父组件改它，触发重新量尺寸
    revision: { type: null as unknown as PropType<unknown>, default: null },
    // 预计算的月份分组纵坐标（提供后滚动时走 O(log G) 二分查找，不再遍历 DOM offsetTop）
    monthOffsets: { type: Array as PropType<Array<{ top: number; label: string }>>, default: undefined },
    // 预计算的总内容高度
    layoutHeight: { type: Number, default: undefined }
  },
  setup(props) {
    const trackH = ref(0)
    const thumbH = ref(MIN_THUMB)
    const thumbY = ref(0)
    const visible = ref(false)
    const percent = ref(0)
    const label = ref('')
    const hover = ref(false)
    const dragging = ref(false)
    const scrolling = ref(false)

    // 缓存滚动容器的总高度与视口高度，只在 ResizeObserver / revision / layoutHeight 变化时刷新
    let cachedScrollHeight = 0
    let cachedClientHeight = 0

    // 悬停、拖动、刚滚动过时完全显出来
    const active = computed(() => hover.value || dragging.value || scrolling.value)
    const bubbleOn = computed(() => props.timeline && (dragging.value || scrolling.value))

    // 当前最上面那个月份（优先走 O(log G) 二分查找，未传 monthOffsets 时保留 DOM 回退）
    const currentMonth = (el: HTMLElement, curTop: number): string => {
      if (!props.timeline) {
        return ''
      }
      if (props.monthOffsets) {
        return findMonthAtOffset(props.monthOffsets, curTop)
      }
      let key = ''
      for (const child of el.children) {
        const section = child as HTMLElement
        if (section.offsetTop - 8 > curTop) {
          break
        }
        key = section.dataset.month ?? ''
      }
      return key ? monthLabel(key) : ''
    }

    const updateThumb = (el: HTMLElement): void => {
      const max = cachedScrollHeight - cachedClientHeight
      visible.value = max > 1
      trackH.value = cachedClientHeight - INSET * 2
      thumbH.value =
        cachedScrollHeight > 0
          ? Math.max(MIN_THUMB, Math.round((cachedClientHeight / cachedScrollHeight) * trackH.value))
          : MIN_THUMB
      const curTop = el.scrollTop
      const ratio = max > 0 ? Math.min(1, Math.max(0, curTop / max)) : 0
      thumbY.value = INSET + ratio * (trackH.value - thumbH.value)
      percent.value = Math.round(ratio * 100)
      label.value = currentMonth(el, curTop)
    }

    // 仅在尺寸或内容修订时测量容器几何，滚动过程中只读 scrollTop
    const refreshMetrics = (): void => {
      const el = props.target
      if (!el) {
        cachedScrollHeight = 0
        cachedClientHeight = 0
        visible.value = false
        return
      }
      cachedClientHeight = el.clientHeight
      cachedScrollHeight = el.scrollHeight > 0 ? el.scrollHeight : (props.layoutHeight ?? 0)
      updateThumb(el)
    }

    // 滚动时合并到下一帧再更新滑块，并在停下一会儿后收起
    let frame = 0
    let idle = 0
    const onScroll = (): void => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          const el = props.target
          if (!el) return
          if (cachedClientHeight === 0 || cachedScrollHeight === 0) {
            refreshMetrics()
          } else {
            updateThumb(el)
          }
        })
      }
      if (!scrolling.value) {
        scrolling.value = true
      }
      clearTimeout(idle)
      idle = window.setTimeout(() => {
        scrolling.value = false
      }, IDLE_MS)
    }

    // 拖到或点到最底时记下来：到底后的一小段时间里内容变高就接着贴底，用户自己滚了就不管
    let stickEnd = false
    let stickUntil = 0
    let smoothBusy = false
    const STICK_MS = 1500
    const snapEnd = (): void => {
      const el = props.target
      if (!stickEnd || !el || dragging.value || smoothBusy) {
        return
      }
      if (performance.now() > stickUntil) {
        stickEnd = false
        return
      }
      if (cachedScrollHeight - cachedClientHeight - el.scrollTop > 1) {
        el.scrollTo({ top: cachedScrollHeight })
      }
    }
    const onScrollEnd = (): void => {
      if (smoothBusy) {
        smoothBusy = false
        stickUntil = performance.now() + STICK_MS
      }
      snapEnd()
    }
    const onUserScroll = (): void => {
      stickEnd = false
    }

    // 把滑块顶端放到轨道上的某个位置，换算成滚动距离
    const scrollToThumb = (y: number, smooth: boolean): void => {
      const el = props.target
      const room = trackH.value - thumbH.value
      if (!el || room <= 0) {
        return
      }
      const max = Math.max(0, cachedScrollHeight - cachedClientHeight)
      const ratio = Math.min(1, Math.max(0, (y - INSET) / room))
      stickEnd = ratio === 1
      stickUntil = performance.now() + STICK_MS
      smoothBusy = smooth && Math.abs(el.scrollTop - ratio * max) > 1
      el.scrollTo({ top: ratio * max, behavior: smooth ? 'smooth' : 'auto' })
    }

    // 拖滑块：记下按下时指针在滑块里的位置和轨道顶边，拖动中零重排
    let grab = 0
    let railTop = 0
    const onThumbDown = (e: PointerEvent): void => {
      if (e.button !== 0) {
        return
      }
      e.preventDefault()
      const thumb = e.currentTarget as HTMLElement
      grab = e.clientY - thumb.getBoundingClientRect().top
      railTop = thumb.parentElement?.getBoundingClientRect().top ?? 0
      thumb.setPointerCapture(e.pointerId)
      dragging.value = true
    }
    const onThumbMove = (e: PointerEvent): void => {
      if (!dragging.value) {
        return
      }
      scrollToThumb(e.clientY - railTop - grab, false)
    }
    const onThumbUp = (e: PointerEvent): void => {
      if (!dragging.value) {
        return
      }
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      dragging.value = false
      stickUntil = performance.now() + STICK_MS
      snapEnd()
    }

    // 点轨道空白处：滑块中心平滑滑到点的位置
    const onRailDown = (e: PointerEvent): void => {
      if (e.button !== 0) {
        return
      }
      e.preventDefault()
      const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top
      scrollToThumb(e.clientY - top - thumbH.value / 2, true)
    }

    // 在滚动条上滚滚轮也照常滚网格
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || !props.target) {
        return
      }
      e.preventDefault()
      stickEnd = false
      props.target.scrollBy({ top: e.deltaY })
    }

    let observer: ResizeObserver | null = null
    const bind = (el: HTMLElement | null, old?: HTMLElement | null): void => {
      old?.removeEventListener('scroll', onScroll)
      old?.removeEventListener('scrollend', onScrollEnd)
      old?.removeEventListener('wheel', onUserScroll)
      old?.removeEventListener('keydown', onUserScroll)
      clearTimeout(idle)
      scrolling.value = false
      observer?.disconnect()
      if (!el) {
        cachedScrollHeight = 0
        cachedClientHeight = 0
        visible.value = false
        return
      }
      el.addEventListener('scroll', onScroll, { passive: true })
      el.addEventListener('scrollend', onScrollEnd)
      el.addEventListener('wheel', onUserScroll, { passive: true })
      el.addEventListener('keydown', onUserScroll)
      observer = new ResizeObserver(() => {
        refreshMetrics()
        snapEnd()
      })
      watchContent()
    }

    // 盯住滚动容器尺寸；仅在未传入预计算布局时才监听子分组节点
    const watchContent = (): void => {
      const el = props.target
      if (!el || !observer) {
        return
      }
      observer.disconnect()
      observer.observe(el)
      if (props.layoutHeight === undefined) {
        for (const child of el.children) {
          observer.observe(child)
        }
      }
      refreshMetrics()
    }

    onMounted(() => bind(props.target))
    watch(
      () => props.target,
      (el, old) => bind(el, old)
    )
    // 分组或总高度变了以后等 DOM 更新完再刷新缓存尺寸
    watch(
      [() => props.revision, () => props.layoutHeight, () => props.monthOffsets],
      () => {
        void nextTick(watchContent)
      }
    )
    onBeforeUnmount(() => {
      props.target?.removeEventListener('scroll', onScroll)
      props.target?.removeEventListener('scrollend', onScrollEnd)
      props.target?.removeEventListener('wheel', onUserScroll)
      props.target?.removeEventListener('keydown', onUserScroll)
      observer?.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(idle)
    })

    return { thumbH, thumbY, visible, percent, label, hover, dragging, active, bubbleOn, onThumbDown, onThumbMove, onThumbUp, onRailDown, onWheel }
  }
})
