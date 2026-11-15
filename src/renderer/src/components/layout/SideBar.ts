import { computed, defineComponent } from 'vue'
import { FolderOpened, Picture, Plus } from '@element-plus/icons-vue'
import NonoBubble from '@/components/nono/NonoBubble.vue'
import { useAppStore } from '@/stores/app'
import { useImportRoot } from '@/composables/useImportRoot'

// 侧边栏：图库入口、已导入目录、诺诺状态播报
export default defineComponent({
  name: 'SideBar',
  components: { FolderOpened, Picture, Plus, NonoBubble },
  setup() {
    const store = useAppStore()
    const { onImport } = useImportRoot()

    // 诺诺按当前状态说一句话
    const nonoMessage = computed(() => {
      if (store.error) {
        return '呜…数据没读出来，点一下重试试看？'
      }
      if (store.loading) {
        return '在翻书架，等我一下下～'
      }
      if (store.roots.length === 0) {
        return '下雨天最适合整理图片啦，先导入一个目录吧～'
      }
      return `已经收好 ${store.roots.length} 个目录啦，扫描功能马上就来！`
    })

    return { store, nonoMessage, onImport }
  }
})
