import { defineStore } from 'pinia'
import type { DbBootState } from '@shared/api'
import { fetchBootState, retryDatabase } from '@/api/system'

// 启动状态：图库数据库能不能打开，决定显示主界面还是“图库数据打不开”
export const useBootStore = defineStore('boot', {
  state: () => ({
    // CHECKING 表示还在向主进程询问
    db: 'CHECKING' as DbBootState | 'CHECKING',
    retrying: false
  }),
  getters: {
    ready: (s) => s.db === 'READY',
    fatal: (s) => s.db === 'LOCKED' || s.db === 'BROKEN' || s.db === 'NOT_OPENED'
  },
  actions: {
    // 读取数据库状态；询问本身失败时按“打不开”处理
    async load(): Promise<void> {
      try {
        this.db = await fetchBootState()
      } catch {
        this.db = 'BROKEN'
      }
    },
    // 重试打开数据库；进行中不重复发起
    async retry(): Promise<void> {
      if (this.retrying) {
        return
      }
      this.retrying = true
      try {
        this.db = await retryDatabase()
      } catch {
        this.db = 'BROKEN'
      } finally {
        this.retrying = false
      }
    }
  }
})
