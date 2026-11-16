// 用 Electron 打开原型渲染出的静态页（1280×820 内容区），供 Playwright 截图和应用对比
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 820, useContentSize: true, show: true, autoHideMenuBar: true })
  void win.loadFile(process.env.PROTO_FILE)
})

app.on('window-all-closed', () => app.quit())
