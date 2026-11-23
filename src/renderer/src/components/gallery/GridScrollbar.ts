import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { monthLabel } from '@/utils/gridLayout'

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
    revision: { type: null as unknown as PropType<unknown>, default: null }
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

    // 悬停、拖动、刚滚动过时完全显出来
    const active = computed(() => hover.value || dragging.value || scrolling.value)
    const bubbleOn = computed(() => props.timeline && (dragging.value || scrolling.value))

    // 当前最上面那个月份（看滚动位置落在哪个分组里）
    const currentMonth = (el: HTMLElement): string => {
      if (!props.timeline) {
        return ''
      }
      let key = ''
      for (const child of el.children) {
        const section = child as HTMLElement
        if (section.offsetTop - 8 > el.scrollTop) {
          break
        }
        key = section.dataset.month ?? ''
      }
      return key ? monthLabel(key) : ''
    }

    // 按滚动容器现在的尺寸和位置摆滑块
    const measure = (): void => {
      const el = props.target
      if (!el) {
        visible.value = false
        return
      }
      const max = el.scrollHeight - el.clientHeight
      visible.value = max > 1
      trackH.value = el.clientHeight - INSET * 2
      thumbH.value = Math.max(MIN_THUMB, Math.round((el.clientHeight / el.scrollHeight) * trackH.value))
      const ratio = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0
      thumbY.value = INSET + ratio * (trackH.value - thumbH.value)
      percent.value = Math.round(ratio * 100)
      label.value = currentMonth(el)
    }

    // 滚动时合并到下一帧再量，并在停下一会儿后收起
    let frame = 0
    let idle = 0
    const onScroll = (): void => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          measure()
        })
      }
      if (!scrolling.value) {
        scrolling.value = true
        props.target?.classList.add('image-grid--scrolling')
      }
      clearTimeout(idle)
      idle = window.setTimeout(() => {
        scrolling.value = false
        props.target?.classList.remove('image-grid--scrolling')
      }, IDLE_MS)
    }

    // 拖到或点到最底时记下来：屏幕外的行是按估计高度占位的，滚过去渲染出来后总高度会变；到底后的一小段时间里内容变高就接着贴底，用户自己滚了就不管
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
      if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) {
        el.scrollTo({ top: el.scrollHeight })
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
      const ratio = Math.min(1, Math.max(0, (y - INSET) / room))
      stickEnd = ratio === 1
      stickUntil = performance.now() + STICK_MS
      smoothBusy = smooth && Math.abs(el.scrollTop - ratio * (el.scrollHeight - el.clientHeight)) > 1
      el.scrollTo({ top: ratio * (el.scrollHeight - el.clientHeight), behavior: smooth ? 'smooth' : 'auto' })
    }

    // 拖滑块：记下按下时指针在滑块里的位置，跟着走
    let grab = 0
    const onThumbDown = (e: PointerEvent): void => {
      if (e.button !== 0) {
        return
      }
      e.preventDefault()
      const thumb = e.currentTarget as HTMLElement
      grab = e.clientY - thumb.getBoundingClientRect().top
      thumb.setPointerCapture(e.pointerId)
      dragging.value = true
    }
    const onThumbMove = (e: PointerEvent): void => {
      if (!dragging.value) {
        return
      }
      const top = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().top ?? 0
      scrollToThumb(e.clientY - top - grab, false)
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
      old?.classList.remove('image-grid--scrolling')
      clearTimeout(idle)
      scrolling.value = false
      observer?.disconnect()
      if (!el) {
        return
      }
      el.addEventListener('scroll', onScroll, { passive: true })
      el.addEventListener('scrollend', onScrollEnd)
      el.addEventListener('wheel', onUserScroll, { passive: true })
      el.addEventListener('keydown', onUserScroll)
      observer = new ResizeObserver(() => {
        measure()
        snapEnd()
      })
      watchContent()
    }

    // 盯住滚动容器和里面每个分组的尺寸：行渲染出来、换档、增删图都会让内容变高变矮
    const watchContent = (): void => {
      const el = props.target
      if (!el || !observer) {
        return
      }
      observer.disconnect()
      observer.observe(el)
      for (const child of el.children) {
        observer.observe(child)
      }
      measure()
    }

    onMounted(() => bind(props.target))
    watch(
      () => props.target,
      (el, old) => bind(el, old)
    )
    // 分组变了以后等 DOM 更新完再重新盯
    watch(
      () => props.revision,
      () => {
        void nextTick(watchContent)
      }
    )
    onBeforeUnmount(() => {
      props.target?.removeEventListener('scroll', onScroll)
      props.target?.removeEventListener('scrollend', onScrollEnd)
      props.target?.removeEventListener('wheel', onUserScroll)
      props.target?.removeEventListener('keydown', onUserScroll)
      props.target?.classList.remove('image-grid--scrolling')
      observer?.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(idle)
    })

    return { thumbH, thumbY, visible, percent, label, hover, dragging, active, bubbleOn, onThumbDown, onThumbMove, onThumbUp, onRailDown, onWheel }
  }
})
