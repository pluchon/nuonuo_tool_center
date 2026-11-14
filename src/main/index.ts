import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataPaths } from './config/paths'
import { closeDatabase, openDatabase } from './db/client'
import { registerIpcHandlers } from './ipc'
import { handleLtmProtocol, registerLtmSchemePrivileges } from './protocol/ltmProtocol'

const currentDir = fileURLToPath(new URL('.', import.meta.url))

registerLtmSchemePrivileges()

// 创建主窗口：开启上下文隔离与沙箱，外部链接交给系统浏览器
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(currentDir, '../renderer/index.html'))
  }
  return win
}

// 启动顺序：数据目录 → 数据库与迁移 → 协议 → IPC → 窗口；数据库失败则直接退出并给出原因
async function bootstrap(): Promise<void> {
  const paths = resolveDataPaths()
  const migrationsFolder = join(app.getAppPath(), 'drizzle')
  try {
    await openDatabase(paths.pgdata, migrationsFolder)
  } catch (err) {
    console.error('[bootstrap] 数据库初始化失败:', err)
    app.exit(1)
    return
  }
  handleLtmProtocol(paths.thumbs)
  registerIpcHandlers(paths)
  createMainWindow()
}

app.whenReady().then(bootstrap)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

// 退出前关闭数据库，确保写入落盘
let closing = false
app.on('will-quit', (event) => {
  if (closing) {
    return
  }
  closing = true
  event.preventDefault()
  void closeDatabase().finally(() => app.exit(0))
})
