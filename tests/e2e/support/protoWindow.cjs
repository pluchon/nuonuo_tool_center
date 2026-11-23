// 用 Electron 打开原型渲染出的静态页（1280×820 内容区），供 Playwright 截图和应用对比
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 820, useContentSize: true,
    show: process.env.LTM_E2E_HIDDEN !== '1', autoHideMenuBar: true
  })
  if (process.env.LTM_E2E_HIDDEN === '1') win.webContents.setBackgroundThrottling(false)
  void win.loadFile(process.env.PROTO_FILE)
})

app.on('window-all-closed', () => app.quit())
