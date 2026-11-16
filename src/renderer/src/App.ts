import { defineComponent, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import AppShell from '@/components/layout/AppShell.vue'
import TitleBar from '@/components/layout/TitleBar.vue'
import DbErrorView from '@/views/db-error/DbErrorView.vue'
import { useThemeSync } from '@/composables/useThemeSync'
import { useBootStore } from '@/stores/boot'
import { useSettingsStore } from '@/stores/settings'

// 应用根：先问数据库能不能打开；能打开就读设置再显示主界面，打不开显示“图库数据打不开”
export default defineComponent({
  name: 'App',
  components: { AppShell, TitleBar, DbErrorView },
  setup() {
    const boot = useBootStore()
    const settings = useSettingsStore()
    useThemeSync()

    // 读设置失败时先用默认值进主界面，并提示一次
    const loadSettings = async (): Promise<void> => {
      try {
        await settings.load()
      } catch (err) {
        settings.markLoaded()
        ElMessage.warning(`设置没有读出来，先用默认设置：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 启动或重试成功后读设置
    watch(
      () => boot.ready,
      (ready) => {
        if (ready && !settings.loaded) {
          void loadSettings()
        }
      }
    )

    onMounted(() => {
      void boot.load()
    })

    return { boot, settings }
  }
})
