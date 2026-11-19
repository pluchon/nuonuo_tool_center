import { defineStore } from 'pinia'

// 图库视图：全部图片 / 还没打标签 / 最近导入 / R-18 图 / 某个目录
export type GalleryView = 'all' | 'untagged' | 'recent' | 'r18' | 'dir'

// 主区页面：图库，或标签管理
export type MainPage = 'gallery' | 'tags'

// 正在看的目录：源目录按 id，类目录按顶层文件夹名
export type DirRef = { kind: 'source'; id: number } | { kind: 'category'; name: string }

// 当前页面和视图（和原型一样是单页切换，不用路由）
export const useViewStore = defineStore('view', {
  state: () => ({
    page: 'gallery' as MainPage,
    view: 'all' as GalleryView,
    dir: null as DirRef | null,
    // 进入图库时要预先选上的标签筛选（标签管理里点“N 张 ›”）；图库读走后清空
    presetTagIds: [] as number[]
  }),
  actions: {
    // 切到某个图库视图
    show(view: Exclude<GalleryView, 'dir'>): void {
      this.page = 'gallery'
      this.view = view
      this.dir = null
    },
    // 切到某个目录
    showDir(dir: DirRef): void {
      this.page = 'gallery'
      this.view = 'dir'
      this.dir = dir
    },
    // 切到标签管理
    showTags(): void {
      this.page = 'tags'
    },
    // 在“全部图片”里只看打了这个标签的图
    showTagImages(tagId: number): void {
      this.presetTagIds = [tagId]
      this.show('all')
    },
    // 图库取走预设的标签筛选
    takePresetTags(): number[] {
      const ids = this.presetTagIds
      this.presetTagIds = []
      return ids
    }
  }
})
