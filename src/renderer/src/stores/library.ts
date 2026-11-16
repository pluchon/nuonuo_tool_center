import { defineStore } from 'pinia'
import type { LibraryOverviewVO } from '@shared/api'
import { fetchLibraryOverview, importSourceRoot } from '@/api/library'
import { ApiError } from '@/api/request'

// 图库概况：侧栏计数、源目录、类目录，底栏图片总数
export const useLibraryStore = defineStore('library', {
  state: () => ({
    overview: null as LibraryOverviewVO | null,
    loading: false,
    error: '',
    importing: false
  }),
  getters: {
    // 还没有任何源目录：主区显示“第一次打开”
    firstRun: (s): boolean => s.overview !== null && s.overview.sources.length === 0
  },
  actions: {
    // 读取图库概况
    async load(): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        this.overview = await fetchLibraryOverview()
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err)
      } finally {
        this.loading = false
      }
    },
    // 选择文件夹导入为源目录，成功后刷新概况；取消时返回 false，其余失败向上抛出
    async importSource(): Promise<boolean> {
      if (this.importing) {
        return false
      }
      this.importing = true
      try {
        await importSourceRoot()
        await this.load()
        return true
      } catch (err) {
        if (err instanceof ApiError && err.code === 'CANCELLED') {
          return false
        }
        throw err
      } finally {
        this.importing = false
      }
    }
  }
})
