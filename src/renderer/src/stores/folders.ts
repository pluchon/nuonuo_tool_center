import { defineStore } from 'pinia'
import { DIR_NAME_MAX, type DirNodeVO, type FolderRefDTO } from '@shared/api'
import { createFolder, deleteFolder, fetchDirChildren, openFolder, removeSource, renameFolder } from '@/api/folders'
import { useLibraryStore } from './library'
import { useScanStore } from './scan'
import { useToastStore } from './toast'
import { dirWithin, toFolderRef, useViewStore, type DirRef } from './view'

// 错误信息
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 字数（一个中文、一个表情都算一个字）
export function charCount(s: string): number {
  return Array.from(s).length
}

// 目录引用拷成普通对象：store 里存的是响应式代理，IPC 只能传普通对象（代理无法结构化克隆）
function plain(ref: FolderRefDTO): FolderRefDTO {
  return ref.kind === 'source' ? { kind: 'source', id: ref.id, sub: ref.sub } : { kind: 'category', path: ref.path }
}

// 目录引用的比较键（不区分大小写）
export function folderKey(ref: FolderRefDTO): string {
  return ref.kind === 'source' ? `s:${ref.id}:${ref.sub.toLowerCase()}` : `c:${ref.path.toLowerCase()}`
}

// 目录引用换成视图里的目录
export function toDirRef(ref: FolderRefDTO): DirRef {
  return ref.kind === 'source' ? { kind: 'source', id: ref.id, sub: ref.sub } : { kind: 'category', name: ref.path }
}

// 最后一段名字
function lastName(rel: string): string {
  return rel.split('\\').pop() ?? rel
}

// 正在侧栏里输入的目录名：新建（在 parent 下）或改名
export type FolderEdit = { mode: 'create'; parent: FolderRefDTO } | { mode: 'rename'; ref: FolderRefDTO }

// 目录右键菜单：点的是哪个目录、是不是顶层、贴在哪里（相对窗口）
export interface FolderMenu {
  ref: FolderRefDTO
  top: boolean
  label: string
  x: number
  y: number
}

// 侧栏目录树：展开状态、子目录、行内输入、右键菜单、删除 / 移除确认
export const useFoldersStore = defineStore('folders', {
  state: () => ({
    // 展开着的目录（键是不区分大小写的比较键，值是原样大小写的引用）
    open: {} as Record<string, FolderRefDTO>,
    kids: {} as Record<string, DirNodeVO[]>,
    edit: null as FolderEdit | null,
    draft: '',
    busy: false,
    menu: null as FolderMenu | null,
    // 删除类目录 / 从图库移除源目录的确认
    danger: null as { ref: FolderRefDTO; label: string } | null
  }),
  getters: {
    isOpen: (s) => (ref: FolderRefDTO): boolean => !!s.open[folderKey(ref)],
    childrenOf: (s) => (ref: FolderRefDTO): DirNodeVO[] => s.kids[folderKey(ref)] ?? [],
    draftOver: (s): boolean => charCount(s.draft.trim()) > DIR_NAME_MAX
  },
  actions: {
    // 读一层子目录（读不了就当没有，提示一下）
    async load(ref: FolderRefDTO): Promise<void> {
      try {
        this.kids[folderKey(ref)] = await fetchDirChildren(plain(ref))
      } catch (err) {
        this.kids[folderKey(ref)] = []
        useToastStore().show(errText(err), 'error')
      }
    },
    // 展开 / 收起
    async toggle(ref: FolderRefDTO): Promise<void> {
      const key = folderKey(ref)
      if (this.open[key]) {
        delete this.open[key]
        return
      }
      await this.expand(ref)
    },
    // 展开并读子目录
    async expand(ref: FolderRefDTO): Promise<void> {
      this.open[folderKey(ref)] = plain(ref)
      await this.load(ref)
    },
    // 目录有变化（新建、改名、删除、扫描完）后重新读所有展开着的目录
    async refresh(): Promise<void> {
      await Promise.all(Object.values(this.open).map((ref) => this.load(ref)))
    },
    // 某个目录改名或删掉后，它和它下面的展开状态、缓存都不再有效
    forgetUnder(ref: FolderRefDTO): void {
      const base = folderKey(ref)
      // 整个源目录（子路径为空）时它下面所有的键都以 “s:id:” 开头
      const prefix = base.endsWith(':') ? base : `${base}\\`
      for (const key of [...Object.keys(this.open), ...Object.keys(this.kids)]) {
        if (key === base || key.startsWith(prefix)) {
          delete this.open[key]
          delete this.kids[key]
        }
      }
    },
    // 当前目录有没有子目录（决定“仅展示当前目录”开关）
    hasChildren(dir: DirRef): boolean {
      const ref = toFolderRef(dir)
      const rel = ref.kind === 'source' ? ref.sub : ref.path
      const ov = useLibraryStore().overview
      if (!rel.includes('\\') && ref.kind === 'category') {
        return ov?.categories.find((c) => c.name.toLowerCase() === rel.toLowerCase())?.hasChildren ?? false
      }
      if (ref.kind === 'source' && !rel) {
        return ov?.sources.find((s) => s.id === ref.id)?.hasChildren ?? false
      }
      for (const list of Object.values(this.kids)) {
        const hit = list.find((d) => d.rel.toLowerCase() === rel.toLowerCase())
        if (hit) {
          return hit.hasChildren
        }
      }
      return false
    },
    // 在 parent 下新建：展开它，出一行输入框
    async startCreate(parent: FolderRefDTO): Promise<void> {
      this.menu = null
      if (this.edit) {
        return
      }
      // 图库文件夹本身（类目录卡片标题的“+”）不用展开；其余在父目录下面出输入行
      const home = parent.kind === 'category' && !parent.path
      if (!home) {
        await this.expand(parent)
      }
      this.draft = ''
      this.edit = { mode: 'create', parent }
    },
    // 改名：这一行换成输入框
    startRename(ref: FolderRefDTO, current: string): void {
      this.menu = null
      if (this.edit) {
        return
      }
      this.draft = current
      this.edit = { mode: 'rename', ref }
    },
    cancelEdit(): void {
      this.edit = null
      this.draft = ''
    },
    // 回车或失焦：新建（空着用默认名）后进入新目录；改名后如果正看着它就跟着换
    async commitEdit(): Promise<void> {
      const edit = this.edit
      if (!edit || this.busy || this.draftOver) {
        return
      }
      const view = useViewStore()
      const toast = useToastStore()
      this.busy = true
      const draft = this.draft.trim()
      try {
        if (edit.mode === 'create') {
          const rel = await createFolder(plain(edit.parent), draft || null)
          this.edit = null
          await this.afterChange()
          const ref: FolderRefDTO = edit.parent.kind === 'source' ? { ...edit.parent, sub: rel } : { kind: 'category', path: rel }
          view.showDir(toDirRef(ref))
        } else {
          const ref = edit.ref
          const oldName = lastName(ref.kind === 'source' ? ref.sub : ref.path)
          if (!draft || draft === oldName) {
            this.edit = null
            return
          }
          const rel = await renameFolder(plain(ref), draft)
          this.edit = null
          this.forgetUnder(ref)
          // 正看着这个目录（或它下面的）：视图跟着换到新路径
          if (ref.kind === 'category' && view.view === 'dir' && dirWithin(view.dir, ref) && view.dir?.kind === 'category') {
            view.showDir({ kind: 'category', name: rel + view.dir.name.slice(ref.path.length) })
          }
          await this.afterChange()
        }
        this.draft = ''
      } catch (err) {
        toast.show(errText(err), 'error')
      } finally {
        this.busy = false
      }
    },
    // 目录结构变了：刷新侧栏数据和展开着的子目录
    async afterChange(): Promise<void> {
      await useLibraryStore().load()
      await this.refresh()
    },
    // 右键菜单
    openMenu(menu: FolderMenu): void {
      this.menu = menu
    },
    closeMenu(): void {
      this.menu = null
    },
    // 在资源管理器里打开
    async reveal(ref: FolderRefDTO): Promise<void> {
      this.menu = null
      try {
        await openFolder(plain(ref))
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    // 只扫这一个源目录
    async rescan(id: number): Promise<void> {
      this.menu = null
      try {
        await useScanStore().start(id)
      } catch (err) {
        useToastStore().show(errText(err), 'error')
      }
    },
    // 删除类目录 / 从图库移除源目录：先确认
    askDanger(ref: FolderRefDTO, label: string): void {
      this.menu = null
      this.danger = { ref, label }
    },
    cancelDanger(): void {
      this.danger = null
    },
    async confirmDanger(): Promise<void> {
      const target = this.danger
      if (!target || this.busy) {
        return
      }
      const view = useViewStore()
      const toast = useToastStore()
      this.busy = true
      try {
        if (target.ref.kind === 'source') {
          await removeSource(target.ref.id)
          toast.show(`已从图库移除「${target.label}」`)
        } else {
          await deleteFolder(plain(target.ref))
          toast.show(`类目录「${target.label}」已放进系统回收站`)
        }
        // 正看着它（或它下面的目录）：回到全部图片
        if (view.view === 'dir' && dirWithin(view.dir, target.ref)) {
          view.show('all')
        }
        this.danger = null
        this.forgetUnder(target.ref)
        await this.afterChange()
      } catch (err) {
        this.danger = null
        toast.show(errText(err), 'error')
      } finally {
        this.busy = false
      }
    }
  }
})
