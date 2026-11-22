import { computed, defineComponent, onMounted } from 'vue'
import { useOrganizeStore } from '@/stores/organize'
import OrganizeDialog from '@/components/dialogs/OrganizeDialog.vue'

// 每个阶段按钮上的字
const LABELS = {
  IDLE: '一键整理',
  LOOKING: '整理中·看图',
  PLANNING: '整理中·出方案',
  PLAN_READY: '方案待确认',
  ASSIGNING: '整理中·分图',
  FOLLOWING: '整理中·补图'
} as const

// 底栏“诺诺在看图”右边的一键整理按钮（设计 6.10）
export default defineComponent({
  name: 'OrganizeButton',
  components: { OrganizeDialog },
  setup() {
    const org = useOrganizeStore()
    onMounted(() => {
      void org.init()
    })
    const label = computed(() => LABELS[org.phase])
    const busy = computed(() => org.phase === 'LOOKING' || org.phase === 'PLANNING' || org.phase === 'ASSIGNING' || org.phase === 'FOLLOWING')
    return { org, label, busy }
  }
})
