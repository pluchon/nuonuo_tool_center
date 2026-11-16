import { defineComponent } from 'vue'
import { ElMessage } from 'element-plus'
import NonoArt from '@/components/nono/NonoArt.vue'
import { useLibraryStore } from '@/stores/library'

// 主区：第一次打开、空状态、读取失败（图片网格在浏览阶段接入）
export default defineComponent({
  name: 'GalleryView',
  components: { NonoArt },
  setup() {
    const library = useLibraryStore()

    // 导入源目录；暂用系统的选择文件夹对话框，按磁盘逐层展开的导入对话框在导入扫描阶段接入
    const onPick = async (): Promise<void> => {
      try {
        await library.importSource()
      } catch (err) {
        ElMessage.error(err instanceof Error ? err.message : String(err))
      }
    }

    return { library, onPick }
  }
})
