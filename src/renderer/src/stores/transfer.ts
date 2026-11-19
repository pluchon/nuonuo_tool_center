import { defineStore } from 'pinia'
import type { TransferResultVO, TransferRootsVO } from '@shared/api'
import { copyImages, fetchTransferRoots, moveImages, undoTransfer } from '@/api/files'
import { fetchImageDetail } from '@/api/gallery'
import { useGalleryStore } from './gallery'
import { useToastStore } from './toast'

// 移动到… / 复制到…
export type TransferMode = 'move' | 'copy'

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 路径所在的文件夹（不区分大小写比较用）
function dirKey(path: string): string {
  return path.slice(0, path.lastIndexOf('\\')).toLowerCase()
}

// 最后一段名字
function lastName(path: string): string {
  return path.replace(/\\$/, '').split('\\').pop() ?? path
}

// 移动 / 复制对话框：选目标目录、执行、提示条上撤销
export const useTransferStore = defineStore('transfer', {
  state: () => ({
    mode: null as TransferMode | null,
    roots: null as TransferRootsVO | null,
    // 选中的目标目录（移动只有一个）
    picked: [] as string[],
    // 单张时：这张图所在的目录（“当前位置”）和已有副本的目录（复制时不能再选），都已转成小写
    here: '',
    copies: [] as string[],
    // 打开时自动展开到这些目录（当前位置、已有副本所在的目录），原样大小写
    expandTo: [] as string[],
    imageCount: 0,
    busy: false
  }),
  actions: {
    // 打开对话框：读两组顶层目录；单张时记下当前位置和已有副本
    async open(mode: TransferMode): Promise<void> {
      const gallery = useGalleryStore()
      const ids = gallery.targets()
      if (ids.length === 0) {
        return
      }
      this.imageCount = ids.length
      this.picked = []
      this.here = ''
      this.copies = []
      this.expandTo = []
      try {
        if (!gallery.multi && gallery.primary !== null) {
          // 详情可能还是上一张的（刚点了新图、详情还没读回来）：不一致就现读
          const detail = gallery.detail?.imageId === gallery.primary ? gallery.detail : await fetchImageDetail(gallery.primary)
          const fileId = gallery.primaryItem?.fileId
          const loc = detail.locations.find((l) => l.fileId === fileId) ?? detail.locations[0]
          this.here = loc ? dirKey(loc.path) : ''
          this.copies = detail.locations.map((l) => dirKey(l.path))
          const dirs = (mode === 'copy' ? detail.locations : loc ? [loc] : []).map((l) => l.path.slice(0, l.path.lastIndexOf('\\')))
          this.expandTo = [...new Set(dirs)]
        }
        this.roots = await fetchTransferRoots()
        this.mode = mode
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    close(): void {
      if (!this.busy) {
        this.mode = null
      }
    },
    // 这个目录能不能选；不能选时返回行尾的说明
    lockOf(path: string): string {
      const key = path.toLowerCase()
      if (key === this.here) {
        return '当前位置'
      }
      if (this.mode === 'copy' && this.copies.includes(key)) {
        return '已有副本'
      }
      return ''
    },
    // 点一行：移动单选，复制多选
    toggle(path: string): void {
      if (this.lockOf(path)) {
        return
      }
      if (this.mode === 'move') {
        this.picked = [path]
      } else {
        this.picked = this.picked.includes(path) ? this.picked.filter((p) => p !== path) : [...this.picked, path]
      }
    },
    // 执行：成功后刷新列表，提示条上可以撤销；有失败的报原因
    async confirm(): Promise<void> {
      const gallery = useGalleryStore()
      const toast = useToastStore()
      const query = gallery.query()
      const mode = this.mode
      if (!query || !mode || this.picked.length === 0 || this.busy) {
        return
      }
      this.busy = true
      // 都是响应式数组，IPC 只能传普通数组
      const ids = [...gallery.targets()]
      const picked = [...this.picked]
      try {
        const res = mode === 'move' ? await moveImages(query, ids, picked[0]) : await copyImages(query, ids, picked)
        this.busy = false
        this.mode = null
        await gallery.afterEdit()
        this.report(mode, res, picked)
      } catch (err) {
        this.busy = false
        toast.show(errText(err), 'error')
      }
    },
    // 结果提示：全失败、部分失败报红；都在原处时说明没动；成功带撤销
    report(mode: TransferMode, res: TransferResultVO, picked: string[]): void {
      const toast = useToastStore()
      const verb = mode === 'move' ? '移动' : '复制'
      if (res.failed > 0) {
        toast.show(`有 ${res.failed} 张没${verb}成功：${res.error ?? '原因不明'}`, 'error')
        return
      }
      if (res.done === 0) {
        toast.show(mode === 'move' ? '已经在这个目录里了' : '这些目录里已经有了')
        return
      }
      const text = mode === 'move' ? `已移动 ${res.done} 张到「${lastName(picked[0])}」` : `已复制 ${this.imageCount} 张到 ${picked.length} 个目录`
      const batchId = res.batchId
      toast.show(
        text,
        'ok',
        batchId === null
          ? undefined
          : async () => {
              try {
                const undo = await undoTransfer(batchId)
                await useGalleryStore().afterEdit()
                if (undo.failed > 0) {
                  toast.show(`有 ${undo.failed} 张没撤销成功：${undo.error ?? '原因不明'}`, 'error')
                }
              } catch (err) {
                toast.show(errText(err), 'error')
              }
            }
      )
    }
  }
})
