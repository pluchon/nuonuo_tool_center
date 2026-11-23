// 在隔离数据目录中启动正常的主进程，不在用户桌面展示窗口。
const { app, BrowserWindow } = require('electron')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

app.setAppPath(process.cwd())
// 隐藏窗口无法完成 Windows 的系统拖放；原生导出用例单独验证传给系统的文件。
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.startDrag = () => { throw new Error('隐藏测试窗口无法向系统拖出文件') }
})
for (const method of ['show', 'showInactive', 'focus', 'maximize']) {
  Object.defineProperty(BrowserWindow.prototype, method, { value() {} })
}
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
import(pathToFileURL(resolve('out/main/index.js')).href)
