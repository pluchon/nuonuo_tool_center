import { defineStore } from 'pinia'
import type { LibraryRootVO, SystemInfoVO } from '@shared/api'
import { fetchSystemInfo } from '@/api/system'
import { fetchLibraryRoots, importLibraryRoot } from '@/api/library'
import { ApiError } from '@/api/request'

// 应用级状态：系统信息与图库目录列表
export const useAppStore = defineStore('app', {
  state: () => ({
    systemInfo: null as SystemInfoVO | null,
    roots: [] as LibraryRootVO[],
    loading: false,
    importing: false,
    error: '' as string
  }),
  actions: {
    // 首屏加载：系统信息与目录列表
    async load(): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        const [info, roots] = await Promise.all([fetchSystemInfo(), fetchLibraryRoots()])
        this.systemInfo = info
        this.roots = roots
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err)
      } finally {
        this.loading = false
      }
    },
    // 导入目录；用户取消时返回 null，其余失败向上抛出
    async importRoot(): Promise<LibraryRootVO | null> {
      this.importing = true
      try {
        const created = await importLibraryRoot()
        this.roots.push(created)
        return created
      } catch (err) {
        if (err instanceof ApiError && err.code === 'CANCELLED') {
          return null
        }
        throw err
      } finally {
        this.importing = false
      }
    }
  }
})
