import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import type { CloseAction } from '@shared/settings'

// 关闭窗口时的行为：退出应用，或者藏到托盘（托盘图标点一下回来，菜单里可以真正退出）
let closeAction: CloseAction = 'quit'
let tray: Tray | null = null
let quitting = false

// 设置里改了“关闭窗口时”
export function setCloseAction(action: CloseAction): void {
  closeAction = action
}

// 真正退出时（托盘菜单“退出”、系统关机、测试关应用）不再拦关闭
export function markQuitting(): void {
  quitting = true
}

// 把窗口找回来
function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return
  }
  if (win.isMinimized()) {
    win.restore()
  }
  win.show()
  win.focus()
}

// 托盘图标（只建一次）
function ensureTray(win: BrowserWindow, iconPath: string): void {
  if (tray) {
    return
  }
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('诺诺的图床')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开诺诺的图床', click: () => showWindow(win) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          markQuitting()
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showWindow(win))
}

// 窗口回来后托盘图标收起
export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

// 给主窗口装上关闭行为：选了“最小化到托盘”时点关闭只是藏起来
export function attachCloseBehavior(win: BrowserWindow, iconPath: string): void {
  win.on('close', (event) => {
    if (quitting || closeAction !== 'tray') {
      return
    }
    event.preventDefault()
    ensureTray(win, iconPath)
    win.hide()
  })
  win.on('show', () => destroyTray())
}
