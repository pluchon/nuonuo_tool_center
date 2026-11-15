import { ElMessage } from 'element-plus'
import { useAppStore } from '@/stores/app'

// 导入目录的交互：调用 store，成功/失败给出提示；侧边栏和首页共用
export function useImportRoot(): { onImport: () => Promise<void> } {
  const store = useAppStore()

  const onImport = async (): Promise<void> => {
    try {
      const created = await store.importRoot()
      if (created) {
        ElMessage.success(`收好啦：${created.name}`)
      }
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : String(err))
    }
  }

  return { onImport }
}
