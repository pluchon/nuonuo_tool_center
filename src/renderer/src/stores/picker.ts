import { defineStore } from 'pinia'
import { pickFolder } from '@/api/system'
import { useLibraryStore } from './library'
import { useToastStore } from './toast'
import { useViewStore } from './view'

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 导入源目录 / 给找不到的源目录重新选择位置：用 Windows 自己的选文件夹对话框；
// 不能选的文件夹（已导入的、它们的上下层、应用自己的图库文件夹）由主进程校验后报原因
export const usePickerStore = defineStore('picker', {
  state: () => ({
    // 系统对话框开着或正在导入
    busy: false
  }),
  actions: {
    // 导入源目录：选好后切到这个源目录
    async openImport(): Promise<void> {
      if (this.busy) {
        return
      }
      this.busy = true
      try {
        const path = await pickFolder('导入源目录')
        if (path) {
          const created = await useLibraryStore().importSource(path)
          useViewStore().showDir({ kind: 'source', id: created.id })
        }
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      } finally {
        this.busy = false
      }
    },
    // 重新选择「X」的位置
    async openRelocate(id: number, name: string): Promise<void> {
      if (this.busy) {
        return
      }
      this.busy = true
      try {
        const path = await pickFolder(`重新选择「${name}」的位置`)
        if (path) {
          await useLibraryStore().relocateSource(id, path)
          useToastStore().show(`「${name}」已改到 ${path}`)
        }
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      } finally {
        this.busy = false
      }
    }
  }
})
