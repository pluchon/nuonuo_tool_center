import { defineStore } from 'pinia'

// 图库视图：全部图片 / 还没打标签 / 最近导入 / R-18 图 / 某个目录
export type GalleryView = 'all' | 'untagged' | 'recent' | 'r18' | 'dir'

// 正在看的目录：源目录按 id，类目录按顶层文件夹名
export type DirRef = { kind: 'source'; id: number } | { kind: 'category'; name: string }

// 当前页面和视图（和原型一样是单页切换，不用路由）
export const useViewStore = defineStore('view', {
  state: () => ({
    view: 'all' as GalleryView,
    dir: null as DirRef | null
  }),
  actions: {
    // 切到某个图库视图
    show(view: Exclude<GalleryView, 'dir'>): void {
      this.view = view
      this.dir = null
    },
    // 切到某个目录
    showDir(dir: DirRef): void {
      this.view = 'dir'
      this.dir = dir
    }
  }
})
