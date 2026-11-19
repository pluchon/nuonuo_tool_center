import { computed, defineComponent, ref, watch } from 'vue'
import { NAME_MAX, type ExifInfoVO, type ImageDetailVO, type ImageLocationVO } from '@shared/api'
import { openFileWithDefault, showFileInFolder, thumbUrl } from '@/api/gallery'
import { useGalleryStore } from '@/stores/gallery'
import { useToastStore } from '@/stores/toast'
import { useTransferStore } from '@/stores/transfer'
import { useViewStore } from '@/stores/view'
import BatchPanel from './BatchPanel.vue'
import TagEditor from './TagEditor.vue'

// 详情面板顶部的状态提示
export interface NoticeVM {
  kind: 'missing' | 'broken' | 'offline'
  title: string
}

// 拍摄信息一块的显示内容
export interface ExifVM {
  taken: string
  camera: string
  lens: string
  params: Array<{ k: string; v: string }>
}

// 文件大小：B / KB / MB / GB
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`
  }
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

// 拍摄时间：YYYY-MM-DD HH:mm:ss（本机时区）
function formatTaken(iso: string | null): string {
  if (!iso) {
    return ''
  }
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 快门：小于 1 秒写成 1/N 秒
function formatShutter(s: number): string {
  return s >= 1 ? `${Number(s.toFixed(1))}s` : `1/${Math.round(1 / s)}s`
}

// 机身：型号里已经带了厂商名就不重复
function cameraOf(e: ExifInfoVO): string {
  const make = e.make ?? ''
  const model = e.model ?? ''
  if (model && make && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0])) {
    return model
  }
  return [make, model].filter(Boolean).join(' ')
}

// 详情面板：单选时显示一张图的预览和信息，多选时显示已选张数（照原型右侧面板；名字、标签、R-18、复制移动在编辑阶段接入）
export default defineComponent({
  name: 'DetailPanel',
  components: { BatchPanel, TagEditor },
  setup() {
    const gallery = useGalleryStore()
    const toast = useToastStore()
    const viewStore = useViewStore()
    const transfer = useTransferStore()

    // 只显示和当前选中一致的详情，避免切换时闪出上一张的信息
    const detail = computed<ImageDetailVO | null>(() =>
      gallery.detail && gallery.detail.imageId === gallery.primary ? gallery.detail : null
    )
    // 显示的那个位置：网格里代表这张图的位置
    const location = computed<ImageLocationVO | undefined>(() => {
      const d = detail.value
      if (!d) {
        return undefined
      }
      const fileId = gallery.primaryItem?.fileId
      return d.locations.find((l) => l.fileId === fileId) ?? d.locations[0]
    })
    const fileName = computed(() => location.value?.path.split('\\').pop() ?? '')
    // 原图打不开（目录找不到、文件不见了）时不能复制、移动
    const canTransfer = computed(() => !!location.value && !location.value.offline && !location.value.missing)
    const dims = computed(() => (detail.value?.width && detail.value.height ? `${detail.value.width}×${detail.value.height}` : ''))
    const size = computed(() => formatBytes(detail.value?.byteSize ?? 0))

    const notice = computed<NoticeVM | null>(() => {
      const loc = location.value
      if (!detail.value || !loc) {
        return null
      }
      if (loc.offline) {
        return { kind: 'offline', title: '原图暂时打不开' }
      }
      if (loc.missing) {
        return { kind: 'missing', title: '文件不见了' }
      }
      if (detail.value.thumb === 'FAILED') {
        return { kind: 'broken', title: '无法预览' }
      }
      return null
    })

    const exif = computed<ExifVM | null>(() => {
      const e = detail.value?.exif
      if (!e) {
        return null
      }
      return {
        taken: formatTaken(detail.value?.takenAt ?? null),
        camera: cameraOf(e),
        lens: e.lens ?? '',
        params: [
          { k: '焦距', v: e.focalLength ? `${Number(e.focalLength.toFixed(1))}mm` : '—' },
          { k: '光圈', v: e.fNumber ? `f/${Number(e.fNumber.toFixed(1))}` : '—' },
          { k: '快门', v: e.exposureTime ? formatShutter(e.exposureTime) : '—' },
          { k: 'ISO', v: e.iso ? String(e.iso) : '—' }
        ]
      }
    })

    // 名字：输入时不截断（会打断中文输入法），超过 15 个字计数变红、不保存；回车或失焦时保存，Esc 放弃
    // 没起过名字时输入框留空、文件名作为占位文字（文件名常常超过 15 个字，不能当成用户输入去计数）
    const nameDraft = ref('')
    watch(
      () => [detail.value?.imageId, detail.value?.displayName] as const,
      () => {
        nameDraft.value = detail.value?.displayName ?? ''
      },
      { immediate: true }
    )
    const nameLen = computed(() => Array.from(nameDraft.value.trim()).length)
    const nameOver = computed(() => nameLen.value > NAME_MAX)
    const onNameInput = (e: Event): void => {
      nameDraft.value = (e.target as HTMLInputElement).value
    }
    const saveName = async (): Promise<void> => {
      const d = detail.value
      if (!d || nameOver.value) {
        return
      }
      const next = nameDraft.value.trim()
      // 没变就不保存；清空等于用回文件名
      if (next === (d.displayName ?? '')) {
        nameDraft.value = next
        return
      }
      await gallery.rename(next)
    }
    const onNameEnter = (e: KeyboardEvent): void => {
      if (!e.isComposing) {
        ;(e.target as HTMLInputElement).blur()
      }
    }
    const onNameCancel = (e: KeyboardEvent): void => {
      nameDraft.value = detail.value?.displayName ?? ''
      ;(e.target as HTMLInputElement).blur()
    }

    // “最近导入”里在面板底部显示导入时间
    const importText = computed(() => (viewStore.view === 'recent' && detail.value ? formatTaken(detail.value.importedAt) : ''))

    const fail = (err: unknown): void => toast.show(err instanceof Error ? err.message : String(err), 'error')
    const onShowInFolder = (): void => {
      if (location.value) {
        showFileInFolder(location.value.fileId).catch(fail)
      }
    }
    const onOpenDefault = (): void => {
      if (location.value) {
        openFileWithDefault(location.value.fileId).catch(fail)
      }
    }

    return {
      gallery,
      transfer,
      canTransfer,
      detail,
      location,
      fileName,
      dims,
      size,
      notice,
      exif,
      thumbUrl,
      nameDraft,
      nameLen,
      nameOver,
      nameMax: NAME_MAX,
      importText,
      onNameInput,
      saveName,
      onNameEnter,
      onNameCancel,
      onShowInFolder,
      onOpenDefault
    }
  }
})
