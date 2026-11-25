import { computed, defineComponent } from 'vue'
import ReorganizeDialog from '@/components/dialogs/ReorganizeDialog.vue'
import { useLookStore } from '@/stores/look'
import { useOrganizeStore } from '@/stores/organize'
import { useScanStore } from '@/stores/scan'

// 底栏“重新整理”按钮：紧邻“一键整理”左侧，打开双模式重新整理弹窗
export default defineComponent({
  name: 'ReorganizeButton',
  components: { ReorganizeDialog },
  setup() {
    const org = useOrganizeStore()
    const look = useLookStore()
    const scan = useScanStore()
    const busy = computed(() => org.reorganizeBusy || look.reorganizing)
    const waiting = computed(() => org.rating.running || scan.running || org.phase !== 'IDLE')
    return { org, busy, waiting }
  }
})
