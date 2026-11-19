import { defineStore } from 'pinia'

// 选文件夹对话框：导入源目录，或给找不到的源目录重新选择位置
export const usePickerStore = defineStore('picker', {
  state: () => ({
    open: false,
    // 重新选择位置时是那个源目录；导入时为空
    relocate: null as { id: number; name: string } | null
  }),
  actions: {
    // 打开“导入源目录”
    openImport(): void {
      this.relocate = null
      this.open = true
    },
    // 打开“重新选择「X」的位置”
    openRelocate(id: number, name: string): void {
      this.relocate = { id, name }
      this.open = true
    },
    // 关闭对话框
    close(): void {
      this.open = false
      this.relocate = null
    }
  }
})
