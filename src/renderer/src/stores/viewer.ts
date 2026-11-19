import { defineStore } from 'pinia'
import { useGalleryStore } from './gallery'

// 大图查看：看的是网格当前选中的那张（gallery.primary），上一张 / 下一张按网格顺序走、首尾相接
export const useViewerStore = defineStore('viewer', {
  state: () => ({
    open: false,
    // 每换一张或重新打开加一（组件据此把缩放、旋转、平移还原）
    seq: 0
  }),
  actions: {
    // 打开：给了 id 就先单选它；没有选中的图就不开
    show(imageId?: number): void {
      const gallery = useGalleryStore()
      if (imageId !== undefined) {
        gallery.selectOne(imageId)
      }
      if (gallery.primary === null || !gallery.items.some((i) => i.imageId === gallery.primary)) {
        return
      }
      this.open = true
      this.seq++
    },
    close(): void {
      this.open = false
    },
    // 上一张（-1）/ 下一张（1）
    step(dir: -1 | 1): void {
      const gallery = useGalleryStore()
      const order = gallery.items.map((i) => i.imageId)
      if (order.length === 0) {
        this.open = false
        return
      }
      const cur = Math.max(0, order.indexOf(gallery.primary ?? order[0]))
      gallery.selectOne(order[(cur + dir + order.length) % order.length])
      this.seq++
    }
  }
})
