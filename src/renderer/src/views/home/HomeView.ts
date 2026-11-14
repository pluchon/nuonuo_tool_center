import { computed, defineComponent, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/stores/app'

// 首页（临时外壳）：展示已导入目录与运行环境，正式页面设计后替换
export default defineComponent({
  name: 'HomeView',
  setup() {
    const store = useAppStore()

    const dbSummary = computed(() => {
      const version = store.systemInfo?.database.postgresVersion ?? ''
      return version.split(' ').slice(0, 2).join(' ')
    })

    const yesNo = (value: boolean): string => (value ? '已配置' : '未配置')

    const onImport = async (): Promise<void> => {
      try {
        const created = await store.importRoot()
        if (created) {
          ElMessage.success(`已导入：${created.name}`)
        }
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err))
      }
    }

    onMounted(() => {
      void store.load()
    })

    return { store, dbSummary, yesNo, onImport }
  }
})
