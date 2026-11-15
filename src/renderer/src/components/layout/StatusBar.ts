import { computed, defineComponent } from 'vue'
import { Collection } from '@element-plus/icons-vue'
import { useAppStore } from '@/stores/app'

// 底部状态栏：目录数、数据库状态、云端凭证是否就绪
export default defineComponent({
  name: 'StatusBar',
  components: { Collection },
  setup() {
    const store = useAppStore()

    const dbLabel = computed(() => {
      const db = store.systemInfo?.database
      if (!db) {
        return ''
      }
      const version = db.postgresVersion.split(' ').slice(0, 2).join(' ')
      return `${version} · ${db.extensions.join(' / ')}`
    })

    const chipClass = (ready: boolean): string => (ready ? 'status-bar__chip--ok' : 'status-bar__chip--off')

    return { store, dbLabel, chipClass }
  }
})
