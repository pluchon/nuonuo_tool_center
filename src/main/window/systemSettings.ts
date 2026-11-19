import { app } from 'electron'
import type { AppSettings } from '@shared/settings'
import { getLogger } from '../common/logger'
import { canTouchLoginItem } from '../services/systemService'
import { setCloseAction } from './trayControl'

const log = getLogger('system')

// 设置里和系统打交道的几项：关闭窗口时的行为、开机自动启动。changed 是这次改了的项（启动时传空，不碰开机登记）
export function applySystemSettings(settings: AppSettings, changed: Partial<AppSettings>): void {
  setCloseAction(settings.closeAction)
  if (!('autostart' in changed)) {
    return
  }
  if (!canTouchLoginItem(process.env)) {
    log.info('开发 / 测试环境，不改开机自动启动的系统登记')
    return
  }
  // 没打包时用 electron.exe 加项目目录启动（和桌面快捷方式一样）
  app.setLoginItemSettings({
    openAtLogin: settings.autostart,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()]
  })
  log.info(`开机自动启动：${settings.autostart ? '开' : '关'}`)
}
