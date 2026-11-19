import { defineStore } from 'pinia'
import type { LibraryOverviewVO, LibraryRootVO, SourceRootVO } from '@shared/api'
import { fetchLibraryOverview, importSourceRoot, relocateSourceRoot } from '@/api/library'

// 图库概况：侧栏计数、源目录、类目录，底栏图片总数和扫描时间
export const useLibraryStore = defineStore('library', {
  state: () => ({
    overview: null as LibraryOverviewVO | null,
    loading: false,
    error: ''
  }),
  getters: {
    // 还没有任何源目录：主区显示“第一次打开”
    firstRun: (s): boolean => s.overview !== null && s.overview.sources.length === 0,
    // 按 id 找源目录
    sourceById:
      (s) =>
      (id: number): SourceRootVO | undefined =>
        s.overview?.sources.find((r) => r.id === id)
  },
  actions: {
    // 读取图库概况；刷新失败时保留上一次读到的数据
    async load(): Promise<void> {
      this.loading = true
      try {
        this.overview = await fetchLibraryOverview()
        this.error = ''
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err)
      } finally {
        this.loading = false
      }
    },
    // 导入一个文件夹为源目录，成功后刷新概况（扫描由主进程自动开始）
    async importSource(path: string): Promise<LibraryRootVO> {
      const created = await importSourceRoot(path)
      await this.load()
      return created
    },
    // 源目录找不到时改到新位置
    async relocateSource(id: number, path: string): Promise<LibraryRootVO> {
      const updated = await relocateSourceRoot(id, path)
      await this.load()
      return updated
    }
  }
})
