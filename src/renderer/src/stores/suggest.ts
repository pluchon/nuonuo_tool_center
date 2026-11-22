import { defineStore } from 'pinia'
import { decideManySuggestions } from '@/api/look'
import { useGalleryStore } from './gallery'
import { useToastStore } from './toast'

// “AI 建议”视图里多张图一起采用或不要：一组、多选、键盘快审（A / X）
export const useSuggestStore = defineStore('suggest', {
  state: () => ({
    busy: false
  }),
  actions: {
    // 一起处理这些图的全部建议；处理完的图离开列表，选中移到下一张
    async decide(imageIds: number[], accept: boolean): Promise<void> {
      if (this.busy || imageIds.length === 0) {
        return
      }
      const toast = useToastStore()
      this.busy = true
      try {
        const res = await decideManySuggestions(imageIds, accept)
        if (res.failed > 0) {
          toast.show(`有 ${res.failed} 张没处理成：${res.error ?? '原因不明'}`, 'error')
        } else if (imageIds.length > 1) {
          toast.show(accept ? `采用了 ${res.done} 张的建议` : `不要了 ${res.done} 张的建议`)
        }
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        this.busy = false
        await useGalleryStore().afterEdit()
      }
    }
  }
})
