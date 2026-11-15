import { defineComponent } from 'vue'
import { FolderOpened } from '@element-plus/icons-vue'
import nonoArt from '@/assets/nono/nono-rain.webp'
import NonoBubble from '@/components/nono/NonoBubble.vue'
import { useAppStore } from '@/stores/app'
import { useImportRoot } from '@/composables/useImportRoot'

// 首页：没有目录时是诺诺的欢迎页；有目录时列出目录（图片网格待扫描功能完成后接入）
export default defineComponent({
  name: 'HomeView',
  components: { FolderOpened, NonoBubble },
  setup() {
    const store = useAppStore()
    const { onImport } = useImportRoot()
    return { store, nonoArt, onImport }
  }
})
