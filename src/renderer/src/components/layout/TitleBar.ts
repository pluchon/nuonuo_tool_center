import { computed, defineComponent } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Moon, Sunny } from '@element-plus/icons-vue'
import nonoArt from '@/assets/nono/nono-rain.webp'
import { useThemeStore } from '@/stores/theme'

// 自绘标题栏：整条可拖动窗口，右侧留出系统窗口按钮的位置
export default defineComponent({
  name: 'TitleBar',
  components: { Moon, Sunny },
  setup() {
    const route = useRoute()
    const theme = useThemeStore()

    const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '')
    const logoStyle = { backgroundImage: `url(${nonoArt})` }

    const onToggleTheme = async (): Promise<void> => {
      try {
        await theme.toggle()
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err))
      }
    }

    return { theme, pageTitle, logoStyle, onToggleTheme }
  }
})
