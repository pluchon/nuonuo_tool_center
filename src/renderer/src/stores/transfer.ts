import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { GalleryQueryDTO, TransferResultVO, TransferRootsVO } from '@shared/api'
import { copyImages, fetchTransferRoots, moveImages, undoTransfer } from '@/api/files'
import { fetchImageDetail } from '@/api/gallery'
import { pickFolder } from '@/api/system'
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

// child 在不在 parent 里面（含相等，不区分大小写）
function within(parent: string, child: string): boolean {
  const p = parent.replace(/\\+$/, '').toLowerCase()
  const c = child.toLowerCase()
  return c === p || c.startsWith(`${p}\\`)
}

// 最后一段名字
function lastName(path: string): string {
  return path.replace(/\\$/, '').split('\\').pop() ?? path
}

// 移动 / 复制对话框：选目标目录、执行、提示条上撤销
export const useTransferStore = defineStore('transfer', {
  state: () => ({
    mode: null as TransferMode | null,
    // 打开时固定操作对象和来源视图，后台刷新或选中项变化不会改变本次文件操作。
    source: null as { ids: number[]; query: GalleryQueryDTO } | null,
    roots: null as TransferRootsVO | null,
    // 选中的目标目录（移动只有一个）
    picked: [] as string[],
    // 用系统对话框选的“其他位置”（可能在图库外）
    others: [] as string[],
    // 单张时：这张图所在的目录（“当前位置”）和已有副本的目录（复制时不能再选），都已转成小写
    here: '',
    copies: [] as string[],
    // 打开时自动展开到这些目录（当前位置、已有副本所在的目录），原样大小写
    expandTo: [] as string[],
    busy: false
  }),
  actions: {
    // 打开对话框：读两组顶层目录；单张时记下当前位置和已有副本
    async open(mode: TransferMode): Promise<void> {
      const gallery = useGalleryStore()
      const ids = gallery.targets()
      const query = gallery.query()
      if (!ids.length || !query || this.mode) {
        return
      }
      const source = markRaw({ ids, query })
      const fileId = gallery.primaryItem?.fileId
      this.source = source
      this.mode = mode
      this.roots = null
      this.picked = []
      this.others = []
      this.here = ''
      this.copies = []
      this.expandTo = []
      try {
        const cachedDetail = gallery.detail?.imageId === ids[0] ? gallery.detail : null
        const [roots, detail] = await Promise.all([
          fetchTransferRoots(),
          ids.length === 1 ? cachedDetail ?? fetchImageDetail(ids[0]) : null
        ])
        if (this.source !== source) return
        if (detail) {
          const loc = detail.locations.find((l) => l.fileId === fileId) ?? detail.locations[0]
          this.here = loc ? dirKey(loc.path) : ''
          this.copies = detail.locations.map((l) => dirKey(l.path))
          const dirs = (mode === 'copy' ? detail.locations : loc ? [loc] : []).map((l) => l.path.slice(0, l.path.lastIndexOf('\\')))
          this.expandTo = [...new Set(dirs)]
        }
        this.roots = roots
      } catch (err) {
        if (this.source !== source) return
        this.close()
        useToastStore().show(errText(err), 'error')
      }
    },
    close(): void {
      if (!this.busy) {
        this.mode = null
        this.source = null
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
    // 这个文件夹在不在图库里（某个源目录或类目录所在的图库文件夹里）
    inLibrary(path: string): boolean {
      const roots = this.roots
      return !!roots && (within(roots.home, path) || roots.sources.some((s) => within(s.path, path)))
    },
    // “其他位置…”：用 Windows 自己的选文件夹对话框，选好的加进列表并选中
    async pickOther(): Promise<void> {
      const mode = this.mode
      const source = this.source
      if (!mode || !this.roots || this.busy) {
        return
      }
      try {
        const path = await pickFolder(mode === 'move' ? '移动到…' : '复制到…')
        if (!path || this.source !== source) {
          return
        }
        if (!this.others.some((p) => p.toLowerCase() === path.toLowerCase())) {
          this.others = [...this.others, path]
        }
        if (!this.picked.includes(path)) {
          this.toggle(path)
        }
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
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
      const source = this.source
      const mode = this.mode
      if (!source || !mode || this.picked.length === 0 || this.busy) {
        return
      }
      this.busy = true
      const ok = await this.runDirect(mode, source.query, source.ids, this.picked)
      this.busy = false
      if (ok) {
        this.close()
      }
    },
    // 执行移动 / 复制（对话框确认、拖到侧栏源目录上都走这里）；成功返回 true
    async runDirect(mode: TransferMode, query: GalleryQueryDTO, rawIds: number[], rawTargets: string[]): Promise<boolean> {
      const gallery = useGalleryStore()
      const toast = useToastStore()
      // 都可能是响应式数组，IPC 只能传普通数组
      const ids = [...rawIds]
      const targets = [...rawTargets]
      try {
        const res = mode === 'move' ? await moveImages(query, ids, targets[0]) : await copyImages(query, ids, targets)
        await gallery.afterEdit()
        this.report(mode, res, targets)
        return true
      } catch (err) {
        toast.show(errText(err), 'error')
        return false
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
      // 移到图库外：说清楚图离开了图库（撤销可以挪回来）
      const outside = mode === 'move' && !this.inLibrary(picked[0])
      const text =
        mode === 'move'
          ? outside
            ? `已把 ${res.done} 张移出图库，放到「${lastName(picked[0])}」`
            : `已移动 ${res.done} 张到「${lastName(picked[0])}」`
          : picked.length === 1
            ? `已复制 ${res.done} 张到「${lastName(picked[0])}」`
            : `已生成 ${res.done} 份副本`
      const batchId = res.batchId
      toast.show(
        res.skipped > 0 ? `${text}，跳过 ${res.skipped} 项` : text,
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
