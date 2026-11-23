import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AI_TEXT_MAX, AI_TITLE_MAX, type AiAttachment, type AiMessageVO, type AiSearchScope, type GalleryItemVO } from '@shared/api'
import { copyImageToClipboard, startNativeDrag } from '@/api/files'
import { thumbUrl } from '@/api/gallery'
import { onRatingR18 } from '@/api/rating'
import SearchResultPages from './SearchResultPages.vue'
import ContextMeter from './ContextMeter.vue'
import NonoArt from '@/components/nono/NonoArt.vue'
import { useAssistantStore } from '@/stores/assistant'
import { useLibraryStore } from '@/stores/library'
import { useToastStore } from '@/stores/toast'
import { useViewerStore } from '@/stores/viewer'
import { ICON } from '@/theme/icons'
import AttachmentCard from './AttachmentCard.vue'
import { isMarkdownFile, readAttachment, readClipboardImage } from './readAttachment'

// 结果图的高度和宽度范围（宽度按原图比例）
const PIC_H = 132
const PIC_W_MIN = 96
const PIC_W_MAX = 240

// 范围下拉里的一项：分组标题，或一个可选的范围
type DirOption =
  | { key: string; head: true; label: string }
  | { key: string; head: false; label: string; icon: string; ink: string; on: boolean; scope: AiSearchScope | null }

// 两位数
const pad = (n: number): string => String(n).padStart(2, '0')

// 对话记录里的日期：今天只写时间，今年写“11月20日”，更早的加年份
export function fmtDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
}

// 回复底部的时间：今天只写时分，其他日子在前面加日期
export function fmtMsg(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${fmtDay(iso, now)} ${hm}`
}

// 诺诺助手页（照原型 ai:）：顶栏（标题、新对话、对话记录）、消息列表、输入框（范围、R-18 开关、发送）
export default defineComponent({
  name: 'AssistantView',
  components: { NonoArt, AttachmentCard, SearchResultPages, ContextMeter },
  setup() {
    const store = useAssistantStore()
    const library = useLibraryStore()
    const viewer = useViewerStore()
    const toast = useToastStore()

    const scroller = ref<HTMLElement | null>(null)
    const inputRef = ref<HTMLTextAreaElement | null>(null)
    const histList = ref<HTMLElement | null>(null)
    // 打开着的弹出：对话记录 / 范围下拉 / “+”菜单
    const menu = ref<'hist' | 'dir' | 'plus' | null>(null)
    const fileRef = ref<HTMLInputElement | null>(null)
    // 对话记录里的右键菜单
    const ctx = ref<{ id: number; top: number } | null>(null)
    const renaming = ref<number | null>(null)
    const renameDraft = ref('')
    // 选中的结果图（消息 id:图片 id）和刚复制过的回复
    const picked = ref<string | null>(null)
    const copied = ref<number | null>(null)
    let copiedTimer: ReturnType<typeof setTimeout> | null = null

    const title = computed(() => (store.ready === false ? '诺诺助手' : (store.current?.title ?? '新对话')))
    const isEmpty = computed(() => store.currentId === null && store.messages.length === 0 && !store.waiting)
    const ctxPinned = computed(() => store.conversations.find((c) => c.id === ctx.value?.id)?.pinned ?? false)

    // 范围下拉：全部类目录及可单独选择的类目录
    const dirOptions = computed<DirOption[]>(() => {
      const ov = library.overview
      const out: DirOption[] = [{ key: 'all', head: false, label: '全部类目录', icon: ICON.img, ink: 'var(--a)', on: store.scope === null, scope: null }]
      if (ov?.categories.length) {
        out.push({ key: 'h-cat', head: true, label: '类目录' })
        for (const c of ov.categories) {
          const scope: AiSearchScope = { kind: 'category', name: c.name }
          out.push({ key: `c${c.name}`, head: false, label: c.name, icon: ICON.heartFolder, ink: 'var(--c-i-C25B85)', on: store.scope?.name === c.name, scope })
        }
      }
      return out
    })
    const scopeLabel = computed(() => store.scope?.name ?? '全部类目录')

    type FileKind = AiAttachment['kind']
    const pendingReads = ref(new Map<FileKind, symbol>())
    const reading = computed(() => pendingReads.value.size > 0)
    const cancelRead = (): void => {
      pendingReads.value.clear()
    }
    // 不同类型可以同时读取，同类型只有最后一次选择可以更新草稿。
    const selectAttachment = async (kind: FileKind, read: () => Promise<AiAttachment>): Promise<void> => {
      const version = Symbol(kind)
      pendingReads.value.set(kind, version)
      try {
        const attachment = await read()
        if (pendingReads.value.get(kind) !== version) return
        const index = store.attachments.findIndex((a) => a.kind === kind)
        if (index < 0) store.attachments = [...store.attachments, attachment]
        else store.attachments = store.attachments.map((file) => file.kind === kind ? attachment : file)
        inputRef.value?.focus()
      } catch (err) {
        if (pendingReads.value.get(kind) === version) {
          const message = err instanceof Error && !(err instanceof DOMException) ? err.message : '无法读取附件'
          toast.show(message, 'error')
        }
      } finally {
        if (pendingReads.value.get(kind) === version) pendingReads.value.delete(kind)
      }
    }
    const removeAttachment = (kind: FileKind): void => {
      pendingReads.value.delete(kind)
      store.attachments = store.attachments.filter((file) => file.kind !== kind)
    }
    const selectFiles = (files: FileList): void => {
      const selected = new Map<FileKind, File>()
      for (const file of Array.from(files)) {
        const kind = isMarkdownFile(file.name) ? 'markdown' : 'image'
        if (kind === 'image' && !file.type.startsWith('image/')) {
          toast.show('请选择图片或 Markdown 文件', 'error')
          continue
        }
        selected.set(kind, file)
      }
      for (const [kind, file] of selected) void selectAttachment(kind, () => readAttachment(file, file.name))
    }
    const pickFile = (): void => {
      menu.value = null
      fileRef.value?.click()
    }
    const onFilePicked = (e: Event): void => {
      const input = e.target as HTMLInputElement
      if (input.files) selectFiles(input.files)
      input.value = ''
    }
    // 粘贴图片：从剪贴板读第一张图
    const pasteFromClipboard = (): void => {
      menu.value = null
      void selectAttachment('image', readClipboardImage)
    }
    // 在输入框里 Ctrl + V：剪贴板里是图就当附件，是字照常粘贴
    const onPaste = (e: ClipboardEvent): void => {
      const files = e.clipboardData?.files
      if (files?.length) {
        e.preventDefault()
        selectFiles(files)
      }
    }

    const toggleMenu = (which: 'hist' | 'dir' | 'plus'): void => {
      menu.value = menu.value === which ? null : which
      ctx.value = null
    }
    const closeMenus = (): void => {
      menu.value = null
      ctx.value = null
    }
    // 点在弹出和它的按钮以外的地方就关掉
    const onDocDown = (e: MouseEvent): void => {
      if (menu.value && !(e.target as HTMLElement).closest('[data-ai-menu]')) {
        closeMenus()
      }
    }
    const pickScope = (scope: AiSearchScope | null): void => {
      store.scope = scope
      menu.value = null
    }

    const onNewChat = async (): Promise<void> => {
      if (store.waiting) return
      cancelRead()
      closeMenus()
      picked.value = null
      await store.newChat()
      inputRef.value?.focus()
    }
    const openChat = async (id: number): Promise<void> => {
      if (store.waiting) return
      if (store.currentId !== id) cancelRead()
      closeMenus()
      picked.value = null
      await store.open(id)
    }
    // 右键：菜单出现在这一行下面
    const openCtx = (id: number, e: MouseEvent): void => {
      const row = e.currentTarget as HTMLElement
      const list = histList.value
      ctx.value = { id, top: row.offsetTop - (list?.scrollTop ?? 0) + row.offsetHeight + 10 }
    }
    const startRename = async (): Promise<void> => {
      const c = store.conversations.find((x) => x.id === ctx.value?.id)
      ctx.value = null
      if (!c) {
        return
      }
      renaming.value = c.id
      renameDraft.value = c.title
      await nextTick()
      const input = document.querySelector<HTMLInputElement>('.assistant__rename-input')
      input?.focus()
      input?.select()
    }
    const saveRename = async (id: number): Promise<void> => {
      if (renaming.value !== id) {
        return
      }
      renaming.value = null
      await store.rename(id, renameDraft.value)
    }
    const ctxPin = async (): Promise<void> => {
      const id = ctx.value?.id
      ctx.value = null
      if (id !== undefined) {
        await store.togglePin(id)
      }
    }
    const ctxDelete = async (): Promise<void> => {
      const id = ctx.value?.id
      ctx.value = null
      if (id !== undefined) {
        await store.remove(id)
      }
    }

    // 输入框：回车发送，Shift + 回车换行；输入法选字时的回车不算
    const onInputKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        if (!reading.value) void store.send()
      } else if (e.key === 'Escape') {
        closeMenus()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        pickFile()
      }
    }

    // 结果图：宽度按原图比例
    const picWidth = (p: GalleryItemVO): number => {
      const ratio = p.width && p.height ? p.width / p.height : 1
      return Math.round(Math.min(PIC_W_MAX, Math.max(PIC_W_MIN, PIC_H * ratio)))
    }
    const pickKey = (messageId: number, imageId: number): string => `${messageId}:${imageId}`
    // 单击选中，再点一次取消
    const pick = (messageId: number, imageId: number): void => {
      const key = pickKey(messageId, imageId)
      picked.value = picked.value === key ? null : key
      closeMenus()
    }
    // 按住拖到别的软件：系统原生拖拽带出原文件（这里没有站内的拖放目标）
    const dragOut = (e: DragEvent, messageId: number, p: GalleryItemVO): void => {
      e.preventDefault()
      if (p.isR18 || p.missing || p.offline) return
      picked.value = pickKey(messageId, p.imageId)
      startNativeDrag([p.fileId], p.hash).catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err), 'error'))
    }
    // 双击打开大图，只在这次回复的结果里切换
    const openViewer = (images: GalleryItemVO[], imageId: number): void => {
      // 查看器会预读相邻原图，只有明确打开的受保护图片才能进入这个列表。
      viewer.showList(images.filter((p) => !p.isR18 || p.imageId === imageId), imageId)
    }
    // 选中的那张图
    const pickedItem = (): GalleryItemVO | null => {
      if (!picked.value) {
        return null
      }
      const [mid, iid] = picked.value.split(':').map(Number)
      return store.messages.find((m) => m.id === mid)?.images.find((i) => i.imageId === iid) ?? null
    }
    // Ctrl + C 复制选中的结果图（输入框里有选中文字时不抢）
    const onKey = (e: KeyboardEvent): void => {
      if (viewer.open || document.querySelector('[aria-modal="true"]')) {
        return
      }
      if (e.key === 'Escape') {
        closeMenus()
        renaming.value = null
        return
      }
      const inField = (e.target as HTMLElement)?.closest('input, textarea')
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !inField) {
        const item = pickedItem()
        if (item) {
          e.preventDefault()
          if (item.isR18) return
          copyImageToClipboard(item.fileId)
            .then(() => toast.show('已复制图片'))
            .catch((err: unknown) => toast.show(err instanceof Error ? err.message : String(err), 'error'))
        }
      }
    }

    // 复制回复的文字
    const copyText = async (m: AiMessageVO): Promise<void> => {
      try {
        await navigator.clipboard.writeText(m.text || m.how || '')
        copied.value = m.id
        if (copiedTimer) {
          clearTimeout(copiedTimer)
        }
        copiedTimer = setTimeout(() => (copied.value = null), 1500)
      } catch {
        toast.show('复制失败', 'error')
      }
    }

    // 有新消息、开始等待或出错时滚到底
    const scrollToEnd = async (): Promise<void> => {
      await nextTick()
      const el = scroller.value
      if (el) {
        el.scrollTop = el.scrollHeight
      }
    }
    watch(() => [store.messages.length, store.waiting, store.failure, store.currentId], scrollToEnd)

    onMounted(() => {
      document.addEventListener('mousedown', onDocDown)
      window.addEventListener('keydown', onKey)
      void store.refreshResults()
      void store.enter().then(() => {
        void scrollToEnd()
        inputRef.value?.focus()
      })
    })
    onBeforeUnmount(onRatingR18(() => store.refreshResults()))
    onBeforeUnmount(() => {
      cancelRead()
      document.removeEventListener('mousedown', onDocDown)
      window.removeEventListener('keydown', onKey)
      if (copiedTimer) {
        clearTimeout(copiedTimer)
      }
    })

    return {
      store,
      scroller,
      inputRef,
      fileRef,
      reading,
      removeAttachment,
      pickFile,
      onFilePicked,
      pasteFromClipboard,
      onPaste,
      histList,
      menu,
      ctx,
      ctxPinned,
      renaming,
      renameDraft,
      picked,
      copied,
      title,
      isEmpty,
      dirOptions,
      scopeLabel,
      titleMax: AI_TITLE_MAX,
      textMax: AI_TEXT_MAX,
      starPath: ICON.spark,
      folderIcon: ICON.folder,
      lockIcon: ICON.lock,
      copyPath: 'M8 8h11v13H8zM5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1',
      checkPath: 'M5 12.5l4.5 4.5L19 7.5',
      upPath: 'M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z',
      downPath: 'M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z',
      fmtDay,
      fmtMsg,
      toggleMenu,
      pickScope,
      onNewChat,
      openChat,
      openCtx,
      startRename,
      saveRename,
      ctxPin,
      ctxDelete,
      onInputKey,
      picWidth,
      thumbUrl,
      pickKey,
      pick,
      dragOut,
      openViewer,
      copyText
    }
  }
})
