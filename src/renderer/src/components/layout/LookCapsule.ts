import { computed, defineComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { organizeUsesLookQueue } from '@shared/api'
import { thumbUrl } from '@/api/gallery'
import NonoArt from '@/components/nono/NonoArt.vue'
import { useLookStore } from '@/stores/look'
import { useOrganizeStore } from '@/stores/organize'
import { ICON } from '@/theme/icons'

// 底栏左侧“诺诺在看图”胶囊（照原型 aiBar）：渐变四角星（排队时按节奏转动）+ 数量；点开是带尖角的卡片
export default defineComponent({
  name: 'LookCapsule',
  components: { NonoArt },
  setup() {
    const look = useLookStore()
    const org = useOrganizeStore()
    const canCancel = computed(() => look.canCancel && !organizeUsesLookQueue(org.phase))
    const pillRef = ref<HTMLButtonElement | null>(null)

    // 点在卡片和胶囊以外的地方、按 Esc 就收起
    const onDocDown = (e: MouseEvent): void => {
      if (look.open && !(e.target as HTMLElement).closest('[data-look-pop]')) {
        look.close()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (look.open && e.key === 'Escape') {
        look.close()
      }
    }
    onMounted(() => {
      document.addEventListener('mousedown', onDocDown)
      window.addEventListener('keydown', onKey)
      void look.init()
    })
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDocDown)
      window.removeEventListener('keydown', onKey)
    })

    return { look, canCancel, pillRef, thumbUrl, starPath: ICON.spark }
  }
})
