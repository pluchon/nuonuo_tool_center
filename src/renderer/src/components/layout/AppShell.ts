import { defineComponent, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import nonoArt from '@/assets/nono/nono-rain.webp'
import { useAppStore } from '@/stores/app'
import { useThemeStore } from '@/stores/theme'
import TitleBar from './TitleBar.vue'
import SideBar from './SideBar.vue'
import StatusBar from './StatusBar.vue'

// 应用外壳：诺诺书屋插画做模糊背景 + 雨丝动画，上面是标题栏、侧边栏、内容区和状态栏
export default defineComponent({
  name: 'AppShell',
  components: { TitleBar, SideBar, StatusBar },
  setup() {
    const store = useAppStore()
    const theme = useThemeStore()
    const artStyle = { backgroundImage: `url(${nonoArt})` }

    onMounted(() => {
      theme.apply().catch((err: unknown) => {
        ElMessage.warning(`窗口按钮配色没有同步：${err instanceof Error ? err.message : String(err)}`)
      })
      void store.load()
    })

    return { artStyle }
  }
})
