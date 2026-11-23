import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DataInfoVO } from '@shared/api'
import { ACCENT_COLORS, AI_CREDENTIAL_KEYS, RANGE_LIMITS, SCAN_FORMATS, type AiCredentialKey, type AiCredentialPatch, type AiCredentialStatus, type AppSettings, type BackgroundKey, type ScanFormat } from '@shared/settings'
import { backgroundUrl, fetchAiCredentials, saveAiCredentials } from '@/api/settings'
import { cleanCache, exportBackup, fetchDataInfo, openDataDir } from '@/api/system'
import { useAssistantStore } from '@/stores/assistant'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore, type SettingsTab } from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'
import { defaultBackground } from '@/theme/palette'
import { sceneOf } from '@/theme/scenes'

// 设置里的一行：名称 + 一种控件
type BoolKey = 'glass' | 'groupByMonth' | 'autostart' | 'confirmDelete' | 'r18Blur' | 'autoScan' | 'watchChanges'
type RangeKey = 'backgroundDim' | 'panelClarity' | 'glassBlur'
interface Opt {
  value: string
  label: string
}
export type SettingRow =
  | { type: 'toggle'; label: string; key: BoolKey }
  | { type: 'seg'; label: string; value: string; opts: Opt[]; pick: (v: string) => void }
  | { type: 'swatch'; label: string }
  | { type: 'bgs'; label: string }
  | { type: 'range'; label: string; key: RangeKey; min: number; max: number; unit: string }
  | { type: 'chips'; label: string }
  | { type: 'path'; label: string; path: string; btn: string; run: () => void; disabled?: boolean }
  | { type: 'credential'; label: string; key: AiCredentialKey }
  | { type: 'value'; label: string; value: string; btn?: string; run?: () => void }
  | { type: 'update'; label: string }
  | { type: 'kbd'; label: string; keys: string[] }
export interface SettingGroup {
  title: string
  rows: SettingRow[]
}

// 左侧分类：名称和图标（照原型）
export const TABS: Array<{ key: SettingsTab; label: string; icon: string }> = [
  { key: 'look', label: '外观', icon: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-.9-.6-1.3-.6-2.1 0-.8.7-1.4 1.6-1.4H17a4 4 0 0 0 4-4c0-5-4-9-9-9zM7.5 11h.01M10 7.5h.01M15 7.5h.01' },
  { key: 'general', label: '常规', icon: 'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4' },
  { key: 'library', label: '图库', icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { key: 'ai', label: 'AI', icon: 'M11 3l2.2 5.8L19 11l-5.8 2.2L11 19l-2.2-5.8L3 11l5.8-2.2L11 3zM19 3v4m-2-2h4m-2 11v5m-2.5-2.5h5' },
  { key: 'data', label: '数据与缓存', icon: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3' },
  { key: 'keys', label: '快捷键', icon: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8' },
  { key: 'about', label: '关于', icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01' }
]

const ACCENT_NAMES = ['紫', '粉', '绿', '蓝', '橙', '灰']
const BG_TILES: Array<{ key: BackgroundKey; label: string }> = [
  { key: 'none', label: '默认' },
  { key: 'halftone', label: 'Halftone' },
  { key: 'plotter', label: 'Plotter' },
  { key: 'paper', label: 'Paper' },
  { key: 'custom', label: '自定义' }
]

// 字节数写成 KB / MB / GB
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) {
    return `${Math.round(n / 1024)} KB`
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

// 检查更新的几个阶段：还没有在线更新渠道，检查完说明暂未开放
type UpdatePhase = 'idle' | 'checking' | 'none'
const UPDATE_UI: Record<UpdatePhase, { icon: string; tip: string; text: string }> = {
  idle: { icon: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', tip: '检查更新', text: '' },
  checking: { icon: 'M21 12a9 9 0 1 1-6.2-8.6', tip: '正在检查', text: '正在检查…' },
  none: { icon: 'M6 12.5l4 4 8-9', tip: '再检查一次', text: '暂未开放在线更新' }
}
const CHECK_MS = 1200
// 滑块松手前不写库，停下这么久后保存
const SAVE_DELAY_MS = 250

const CREDENTIAL_PLACEHOLDERS = { saved: '已保存', environment: '使用环境变量', missing: '未设置' } as const
const emptyCredentials = (): Record<AiCredentialKey, string> => ({ dashscopeApiKey: '', aliyunAccessKeyId: '', aliyunAccessKeySecret: '' })

// 设置弹窗（照原型 setDlg）：900×620 磨砂玻璃，左侧分类、右侧分组卡片
export default defineComponent({
  name: 'SettingsDialog',
  setup() {
    const settings = useSettingsStore()
    const library = useLibraryStore()
    const toast = useToastStore()
    const info = ref<DataInfoVO | null>(null)
    const update = ref<UpdatePhase>('idle')
    const busy = ref(false)
    const credentialStatus = ref<AiCredentialStatus | null>(null)
    const credentialDraft = ref(emptyCredentials())
    const queuedCredentials = new Map<AiCredentialKey, AiCredentialPatch>()
    const closeRef = ref<HTMLButtonElement | null>(null)
    let updateTimer: ReturnType<typeof setTimeout> | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let pending: Partial<AppSettings> = {}

    const v = computed(() => settings.values)
    const isDark = computed(() => settings.theme === 'dark')

    const fail = (err: unknown): void => toast.show(err instanceof Error ? err.message : String(err), 'error')

    const loadCredentials = async (): Promise<void> => {
      try {
        credentialStatus.value = await fetchAiCredentials()
      } catch (err) {
        fail(err)
      }
    }
    const persistCredentials = (resetKey?: AiCredentialKey): void => {
      if (!credentialStatus.value) return
      const patch: AiCredentialPatch = {}
      if (resetKey) {
        credentialDraft.value[resetKey] = ''
      }
      for (const key of resetKey ? [resetKey] : AI_CREDENTIAL_KEYS) {
        const value = key === resetKey ? null : credentialDraft.value[key].trim()
        if (value === '') {
          credentialDraft.value[key] = ''
        } else if (queuedCredentials.get(key)?.[key] !== value) {
          patch[key] = value
          queuedCredentials.set(key, patch)
        }
      }
      if (!Object.keys(patch).length) return
      void saveAiCredentials(patch)
        .then((next) => {
          const wasReady = credentialStatus.value?.dashscopeApiKey !== 'missing'
          credentialStatus.value = next
          for (const key of AI_CREDENTIAL_KEYS) {
            if (queuedCredentials.get(key) === patch && patch[key] === credentialDraft.value[key].trim()) {
              credentialDraft.value[key] = ''
            }
          }
          if (wasReady !== (next.dashscopeApiKey !== 'missing') && useViewStore().page === 'assistant') {
            void useAssistantStore().enter()
          }
        })
        .catch(fail)
        .finally(() => {
          for (const key of AI_CREDENTIAL_KEYS) {
            if (queuedCredentials.get(key) === patch) queuedCredentials.delete(key)
          }
        })
    }
    // 在密钥字段之间切换时合并提交，避免只保存一半 AccessKey。
    const onCredentialFocusOut = (event: FocusEvent): void => {
      if (settings.tab !== 'ai') return
      const next = event.relatedTarget
      if (!(next instanceof HTMLElement) || !next.closest('.set-dlg__credential, .set-dlg__credential-reset')) {
        persistCredentials()
      }
    }
    const flushCredentials = (): void => persistCredentials()

    // 改一项或几项：存进库，以主进程返回为准
    const save = (patch: Partial<AppSettings>): void => {
      settings.update(patch).catch(fail)
    }
    const flushPending = (): void => {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (Object.keys(pending).length > 0) {
        const patch = pending
        pending = {}
        save(patch)
      }
    }
    // 滑块：界面先变，停下后再存
    const onRange = (key: RangeKey, e: Event): void => {
      const value = Number((e.target as HTMLInputElement).value)
      settings.preview({ [key]: value })
      pending = { ...pending, [key]: value }
      if (saveTimer) {
        clearTimeout(saveTimer)
      }
      saveTimer = setTimeout(flushPending, SAVE_DELAY_MS)
    }
    const toggle = (key: BoolKey): void => save({ [key]: !v.value[key] })

    const loadInfo = async (): Promise<void> => {
      try {
        info.value = await fetchDataInfo()
      } catch (err) {
        fail(err)
      }
    }

    // 背景格子：每个格子的底图和是否选中
    const bgTiles = computed(() =>
      BG_TILES.map((t) => {
        let bg = ''
        if (t.key === 'none') {
          bg = defaultBackground(v.value.accent, isDark.value)
        } else if (t.key === 'custom') {
          bg = v.value.customBackground ? `url("${backgroundUrl(v.value.customBackground)}") center / cover no-repeat` : 'transparent'
        } else {
          const scene = sceneOf(t.key, isDark.value)
          bg = `url("${scene.url}") center / cover no-repeat, ${scene.paper}`
        }
        const on = v.value.background === t.key && (t.key !== 'custom' || !!v.value.customBackground)
        return { ...t, bg, on, empty: t.key === 'custom' && !v.value.customBackground }
      })
    )
    const hasBg = computed(() => bgTiles.value.some((t) => t.on && t.key !== 'none'))

    const pickBg = async (key: BackgroundKey): Promise<void> => {
      if (key === 'custom' && !v.value.customBackground) {
        await replaceBg()
        return
      }
      save({ background: key })
    }
    const replaceBg = async (): Promise<void> => {
      try {
        await settings.pickBackground()
      } catch (err) {
        fail(err)
      }
    }

    // 扫描的格式：至少留一种
    const toggleFormat = (f: ScanFormat): void => {
      const cur = v.value.scanFormats
      if (cur.includes(f)) {
        if (cur.length === 1) {
          toast.show('至少留一种格式', 'error')
          return
        }
        save({ scanFormats: cur.filter((x) => x !== f) })
      } else {
        save({ scanFormats: SCAN_FORMATS.filter((x) => x === f || cur.includes(x)) })
      }
    }

    const changeHome = async (): Promise<void> => {
      try {
        if (await settings.pickCategoryHome()) {
          await Promise.all([loadInfo(), library.load()])
          toast.show('已更换类目录的位置')
        }
      } catch (err) {
        fail(err)
      }
    }

    const onOpenData = (): void => {
      openDataDir().catch(fail)
    }
    const onClean = async (): Promise<void> => {
      if (busy.value) {
        return
      }
      busy.value = true
      try {
        const res = await cleanCache()
        toast.show(res.removed > 0 ? `清理了 ${res.removed} 张用不到的缩略图，腾出 ${formatBytes(res.freedBytes)}` : '没有用不到的缩略图')
        await loadInfo()
      } catch (err) {
        fail(err)
      } finally {
        busy.value = false
      }
    }
    const onBackup = async (): Promise<void> => {
      if (busy.value) {
        return
      }
      busy.value = true
      try {
        const where = await exportBackup()
        if (where) {
          toast.show(`已导出备份到 ${where}`)
        }
      } catch (err) {
        fail(err)
      } finally {
        busy.value = false
      }
    }

    const runUpdate = (): void => {
      if (update.value === 'checking') {
        return
      }
      update.value = 'checking'
      updateTimer = setTimeout(() => {
        update.value = 'none'
      }, CHECK_MS)
    }

    const seg = (label: string, value: string, opts: Array<[string, string]>, pick: (v: string) => void): SettingRow => ({
      type: 'seg',
      label,
      value,
      opts: opts.map(([value, label]) => ({ value, label })),
      pick
    })
    const kbd = (label: string, keys: string[]): SettingRow => ({ type: 'kbd', label, keys })

    const groups = computed<SettingGroup[]>(() => {
      const s = v.value
      switch (settings.tab) {
        case 'look':
          return [
            {
              title: '主题',
              rows: [
                seg('外观模式', s.appearance, [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']], (x) => save({ appearance: x as AppSettings['appearance'] })),
                { type: 'swatch', label: '主题色' }
              ]
            },
            {
              title: '背景',
              rows: [
                { type: 'bgs', label: '' },
                ...(hasBg.value ? [{ type: 'range', label: '背景淡化', key: 'backgroundDim', min: RANGE_LIMITS.backgroundDim[0], max: RANGE_LIMITS.backgroundDim[1], unit: '%' } as SettingRow] : []),
                { type: 'toggle', label: '磨砂玻璃', key: 'glass' },
                { type: 'range', label: '组件透明度', key: 'panelClarity', min: RANGE_LIMITS.panelClarity[0], max: RANGE_LIMITS.panelClarity[1], unit: '%' },
                ...(s.glass ? [{ type: 'range', label: '模糊程度', key: 'glassBlur', min: RANGE_LIMITS.glassBlur[0], max: RANGE_LIMITS.glassBlur[1], unit: 'px' } as SettingRow] : [])
              ]
            },
            { title: '图片网格', rows: [{ type: 'toggle', label: '按月份分组', key: 'groupByMonth' }] }
          ]
        case 'general':
          return [
            {
              title: '启动与关闭',
              rows: [
                { type: 'toggle', label: '开机自动启动', key: 'autostart' },
                seg('关闭窗口时', s.closeAction, [['quit', '退出应用'], ['tray', '最小化到托盘']], (x) => save({ closeAction: x as AppSettings['closeAction'] }))
              ]
            },
            {
              title: '图片操作',
              rows: [
                { type: 'toggle', label: '删除前确认', key: 'confirmDelete' },
                { type: 'toggle', label: 'R-18 缩略图模糊', key: 'r18Blur' },
                seg('默认排序', s.defaultSort, [['new', '最近导入'], ['taken', '拍摄时间'], ['name', '名称']], (x) => save({ defaultSort: x as AppSettings['defaultSort'] }))
              ]
            }
          ]
        case 'library':
          return [
            {
              title: '扫描',
              rows: [
                { type: 'toggle', label: '启动时自动扫描', key: 'autoScan' },
                { type: 'toggle', label: '实时监听文件变化', key: 'watchChanges' },
                { type: 'chips', label: '扫描的格式' },
                seg('跳过小图', s.skipSmall, [['none', '不跳过'], ['10', '小于 10 KB'], ['50', '小于 50 KB']], (x) => save({ skipSmall: x as AppSettings['skipSmall'] }))
              ]
            },
            {
              title: '位置',
              rows: [
                {
                  type: 'path',
                  label: '类目录保存的位置',
                  path: info.value?.categoryHome ?? '',
                  btn: '更改…',
                  run: () => void changeHome(),
                  disabled: !info.value || info.value.categoryHomeLocked
                }
              ]
            }
          ]
        case 'ai':
          return [{
            title: '阿里云',
            rows: [
              { type: 'credential', label: '百炼 API Key', key: 'dashscopeApiKey' },
              { type: 'credential', label: 'AccessKey ID', key: 'aliyunAccessKeyId' },
              { type: 'credential', label: 'AccessKey Secret', key: 'aliyunAccessKeySecret' }
            ]
          }]
        case 'data':
          return [
            { title: '存储位置', rows: [{ type: 'path', label: '数据文件夹', path: info.value?.dataDir ?? '', btn: '打开', run: onOpenData }] },
            {
              title: '缓存',
              rows: [
                {
                  type: 'value',
                  label: '缩略图缓存',
                  value: info.value ? formatBytes(info.value.cacheBytes) : '…',
                  ...(info.value && info.value.cacheBytes > 0 ? { btn: '清理', run: () => void onClean() } : {})
                }
              ]
            },
            { title: '备份', rows: [{ type: 'value', label: '图库数据', value: '', btn: '导出备份…', run: () => void onBackup() }] }
          ]
        case 'keys':
          return [
            {
              title: '浏览与选择',
              rows: [
                kbd('打开大图', ['Enter']),
                kbd('快速预览', ['空格']),
                kbd('第一张 / 最后一张', ['Home', 'End']),
                kbd('搜索', ['Ctrl', 'F']),
                kbd('上一张 / 下一张', ['←', '→']),
                kbd('上一行 / 下一行', ['↑', '↓']),
                kbd('多选', ['Ctrl', '点击']),
                kbd('连续选择', ['Shift', '点击']),
                kbd('全选', ['Ctrl', 'A']),
                kbd('复制图片', ['Ctrl', 'C']),
                kbd('删除', ['Delete']),
                kbd('AI 建议全部采用 / 不要', ['A', 'X']),
                kbd('缩略图大小', ['Ctrl', '滚轮']),
                kbd('大图缩放', ['Ctrl', '滚轮']),
                kbd('大图放大 / 缩小', ['+', '−']),
                kbd('适应窗口 / 原始大小', ['0', '1']),
                kbd('切换原始大小', ['双击大图']),
                kbd('关闭弹窗', ['Esc'])
              ]
            }
          ]
        case 'about':
          return [
            { title: '版本', rows: [{ type: 'update', label: '当前版本' }] },
            { title: '统计', rows: [{ type: 'value', label: '图片总数', value: `${(library.overview?.counts.total ?? 0).toLocaleString('en-US')} 张` }] }
          ]
      }
      return []
    })

    const accents = computed(() => ACCENT_COLORS.map((c, i) => ({ color: c, label: ACCENT_NAMES[i], on: v.value.accent === c })))
    const formats = computed(() => SCAN_FORMATS.map((f) => ({ label: f, on: v.value.scanFormats.includes(f) })))
    const updateUi = computed(() => UPDATE_UI[update.value])

    // 点遮罩关闭；在弹窗里按下、拖到外面松手不算
    let downOnMask = false
    const onMaskDown = (e: MouseEvent): void => {
      downOnMask = e.target === e.currentTarget
    }
    const onMaskClick = (e: MouseEvent): void => {
      if (downOnMask && e.target === e.currentTarget) {
        close()
      }
      downOnMask = false
    }
    const close = (): void => {
      flushPending()
      persistCredentials()
      settings.closeDialog()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (settings.dialogOpen && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }

    watch(
      () => settings.dialogOpen,
      (open) => {
        if (open) {
          update.value = 'idle'
          void loadInfo()
          if (settings.tab === 'ai' && !credentialStatus.value) void loadCredentials()
          setTimeout(() => closeRef.value?.focus())
        } else {
          persistCredentials()
        }
      }
    )
    // 切到“数据与缓存”时重新读一次缓存大小
    watch(
      () => settings.tab,
      (tab, previous) => {
        if (previous === 'ai') persistCredentials()
        if (settings.dialogOpen && (tab === 'data' || tab === 'library')) {
          void loadInfo()
        }
        if (settings.dialogOpen && tab === 'ai' && !credentialStatus.value) void loadCredentials()
      }
    )

    onMounted(() => {
      window.addEventListener('keydown', onKey, true)
      window.addEventListener('beforeunload', flushCredentials)
    })
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('beforeunload', flushCredentials)
      flushPending()
      persistCredentials()
      if (updateTimer) {
        clearTimeout(updateTimer)
      }
    })

    return {
      settings,
      info,
      tabs: TABS,
      groups,
      accents,
      formats,
      bgTiles,
      updateUi,
      update,
      closeRef,
      busy,
      credentialStatus,
      credentialDraft,
      credentialPlaceholders: CREDENTIAL_PLACEHOLDERS,
      persistCredentials,
      onCredentialFocusOut,
      save,
      toggle,
      onRange,
      flushPending,
      pickBg,
      replaceBg,
      toggleFormat,
      runUpdate,
      close,
      onMaskDown,
      onMaskClick
    }
  }
})
