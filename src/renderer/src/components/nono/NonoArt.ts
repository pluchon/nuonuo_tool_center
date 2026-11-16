import { computed, defineComponent, type PropType } from 'vue'
import welcomeArt from '@/assets/nono/welcome.webp'
import emptyArt from '@/assets/nono/empty.webp'
import errorArt from '@/assets/nono/db-error.webp'

// 诺诺插画的场合：第一次打开 / 空状态和没有结果 / 打不开、读不出来
export type NonoPose = 'welcome' | 'empty' | 'error'

const ART: Record<NonoPose, { src: string; alt: string }> = {
  welcome: { src: welcomeArt, alt: '诺诺抱着空白相册挥手' },
  empty: { src: emptyArt, alt: '诺诺往空纸箱里看' },
  error: { src: errorArt, alt: '诺诺抱着打不开的相册' }
}

// 状态页的诺诺插画（透明底，不跟深色模式变色）：large 用在第一次打开（240px），normal 用在其它状态（200px）
export default defineComponent({
  name: 'NonoArt',
  props: {
    pose: { type: String as PropType<NonoPose>, required: true },
    size: { type: String as PropType<'normal' | 'large'>, default: 'normal' }
  },
  setup(props) {
    const src = computed(() => ART[props.pose].src)
    const alt = computed(() => ART[props.pose].alt)
    return { src, alt }
  }
})
