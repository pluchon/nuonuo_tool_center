import { defineStore } from 'pinia'
import type { GalleryItemVO } from '@shared/api'
import { useGalleryStore } from './gallery'

// 大图查看：默认看的是网格当前选中的那张（gallery.primary），上一张 / 下一张按网格顺序走、首尾相接；
// 从诺诺助手里打开时看的是那次回复的结果图，只在这几张里切换
export const useViewerStore = defineStore('viewer', {
  state: () => ({
    open: false,
    attachment: null as { name: string; dataUrl: string; preview?: string } | null,
    // 每换一张或重新打开加一（组件据此把缩放、旋转、平移还原）
    seq: 0,
    // 诺诺助手里打开时的图片列表和当前那张；为空表示看网格
    list: null as GalleryItemVO[] | null,
    current: null as number | null
  }),
  getters: {
    // 能切换的全部图
    items(s): GalleryItemVO[] {
      if (s.attachment) return []
      return s.list ?? useGalleryStore().items
    },
    // 当前那张的 id
    currentId(s): number | null {
      if (s.attachment) return null
      return s.list ? s.current : useGalleryStore().primary
    },
    // 当前那张
    currentItem(): GalleryItemVO | null {
      return this.items.find((i) => i.imageId === this.currentId) ?? null
    }
  },
  actions: {
    // 打开：给了 id 就先单选它；没有选中的图就不开
    show(imageId?: number): void {
      this.attachment = null
      const gallery = useGalleryStore()
      this.list = null
      this.current = null
      if (imageId !== undefined) {
        gallery.selectOne(imageId)
      }
      if (gallery.primary === null || !gallery.items.some((i) => i.imageId === gallery.primary)) {
        return
      }
      this.open = true
      this.seq++
    },
    // 在一组给定的图里打开某一张（诺诺回复的结果图）
    showList(items: GalleryItemVO[], imageId: number): void {
      if (!items.some((i) => i.imageId === imageId)) {
        return
      }
      this.attachment = null
      this.list = items
      this.current = imageId
      this.open = true
      this.seq++
    },
    showAttachment(name: string, dataUrl: string, preview?: string): void {
      this.list = null
      this.current = null
      this.attachment = { name: name || '图片', dataUrl, preview }
      this.open = true
      this.seq++
    },
    close(): void {
      this.attachment = null
      this.open = false
      this.list = null
      this.current = null
    },
    // 上一张（-1）/ 下一张（1）
    step(dir: -1 | 1): void {
      if (this.attachment) return
      const order = this.items.map((i) => i.imageId)
      if (order.length === 0) {
        this.close()
        return
      }
      const cur = Math.max(0, order.indexOf(this.currentId ?? order[0]))
      const next = order[(cur + dir + order.length) % order.length]
      if (this.list) {
        this.current = next
      } else {
        useGalleryStore().selectOne(next)
      }
      this.seq++
    }
  }
})
