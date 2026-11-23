import { defineStore } from 'pinia'
import type { FolderRefDTO } from '@shared/api'

// 图库视图：全部图片 / 还没打标签 / 最近导入 / R-18 图 / AI 建议 / 某个目录
export type GalleryView = 'all' | 'untagged' | 'recent' | 'r18' | 'ai' | 'dir'

// 主区页面：图库、标签管理，或诺诺助手
export type MainPage = 'gallery' | 'tags' | 'assistant'

// 正在看的目录：源目录按 id（sub 是子文件夹，空表示整个源目录），类目录按相对图库文件夹的路径（可以带子目录）
export type DirRef = { kind: 'source'; id: number; sub?: string } | { kind: 'category'; name: string }

const PANEL_KEY = 'ltm.closedRightPanels'

function readClosedPanels(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

// 目录引用换成主进程用的格式
export function toFolderRef(dir: DirRef): FolderRefDTO {
  return dir.kind === 'source' ? { kind: 'source', id: dir.id, sub: dir.sub ?? '' } : { kind: 'category', path: dir.name }
}

// 两个目录是不是同一个（不区分大小写）
export function sameDir(a: DirRef | null, b: DirRef | null): boolean {
  if (!a || !b || a.kind !== b.kind) {
    return false
  }
  if (a.kind === 'source' && b.kind === 'source') {
    return a.id === b.id && (a.sub ?? '').toLowerCase() === (b.sub ?? '').toLowerCase()
  }
  return a.kind === 'category' && b.kind === 'category' && a.name.toLowerCase() === b.name.toLowerCase()
}

// dir 是不是 parent 本身或在它下面
export function dirWithin(dir: DirRef | null, parent: FolderRefDTO): boolean {
  if (!dir) {
    return false
  }
  const under = (rel: string, base: string): boolean => {
    const r = rel.toLowerCase()
    const b = base.toLowerCase()
    return b === '' || r === b || r.startsWith(`${b}\\`)
  }
  if (dir.kind === 'source' && parent.kind === 'source') {
    return dir.id === parent.id && under(dir.sub ?? '', parent.sub)
  }
  return dir.kind === 'category' && parent.kind === 'category' && under(dir.name, parent.path)
}

// 当前页面和视图（和原型一样是单页切换，不用路由）
export const useViewStore = defineStore('view', {
  state: () => ({
    page: 'gallery' as MainPage,
    view: 'all' as GalleryView,
    dir: null as DirRef | null,
    closedPanels: readClosedPanels(),
    // 进入图库时要预先选上的标签筛选（标签管理里点“N 张 ›”）；图库读走后清空
    presetTagIds: [] as number[]
  }),
  getters: {
    panelKey(state): string {
      if (state.page !== 'gallery') return state.page
      if (state.view !== 'dir' || !state.dir) return state.view
      const dir = state.dir
      return dir.kind === 'source'
        ? `source:${dir.id}:${(dir.sub ?? '').toLowerCase()}`
        : `category:${dir.name.toLowerCase()}`
    },
    panelOpen(): boolean {
      return !this.closedPanels.includes(this.panelKey)
    }
  },
  actions: {
    setPanelOpen(open: boolean): void {
      if (open === this.panelOpen) return
      this.closedPanels = open ? this.closedPanels.filter((key) => key !== this.panelKey) : [...this.closedPanels, this.panelKey]
      try {
        localStorage.setItem(PANEL_KEY, JSON.stringify(this.closedPanels))
      } catch {
        // 存储不可用时继续保留当前会话的选择。
      }
    },
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
    // 切到诺诺助手
    showAssistant(): void {
      this.page = 'assistant'
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
