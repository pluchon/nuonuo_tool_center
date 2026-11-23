import { computed, defineComponent } from 'vue'
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '@/api/window'
// 应用图标（和桌面快捷方式、任务栏同一张，scripts/make-icon.mjs 生成）
import brandAvatar from '@/assets/brand/app-icon.png'
import { useSettingsStore } from '@/stores/settings'
import { useViewStore } from '@/stores/view'
import { useGalleryStore } from '@/stores/gallery'

// 自绘标题栏：左边品牌和设置，右边三颗窗口按钮；整条可拖动窗口
export default defineComponent({
  name: 'TitleBar',
  setup() {
    const settings = useSettingsStore()
    const view = useViewStore()
    const gallery = useGalleryStore()
    const hasPanel = computed(() => settings.loaded &&
      (view.page === 'tags' || (view.page === 'gallery' && gallery.items.length > 0)))
    const panelLabel = computed(() => (view.panelOpen ? '收起' : '展开') + (view.page === 'tags' ? '标签编辑栏' : '图片详情栏'))
    // 齿轮：开着就关、关着就开
    const onGear = (): void => {
      if (settings.dialogOpen) {
        settings.closeDialog()
      } else {
        settings.openDialog()
      }
    }
    // 窗口按钮失败（窗口正在关闭）时没有可补救的操作，忽略即可
    const onMinimize = (): void => {
      minimizeWindow().catch(() => undefined)
    }
    const onToggleMaximize = (): void => {
      toggleMaximizeWindow().catch(() => undefined)
    }
    const onClose = (): void => {
      closeWindow().catch(() => undefined)
    }
    return { settings, view, hasPanel, panelLabel, brandAvatar, onGear, onMinimize, onToggleMaximize, onClose }
  }
})
