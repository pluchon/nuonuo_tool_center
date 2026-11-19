import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IpcEvent, type ScanStateVO, type ThemeMode } from '@shared/api'
import { buildDataPaths, resolveDataRoot } from './config/paths'
import { getLogger, initLogger } from './common/logger'
import { registerIpcHandlers } from './ipc'
import { handleLtmProtocol, registerLtmSchemePrivileges } from './protocol/ltmProtocol'
import { bootDatabase, shutdownDatabase, type DatabaseLocation } from './services/databaseService'
import { configureScan, onScanState, startScan, stopScanAndWait } from './services/scan/scanService'
import { getSettings } from './services/settingsService'
import { windowBackground } from './window/windowControl'

const currentDir = fileURLToPath(new URL('.', import.meta.url))

// 数据目录必须在 requestSingleInstanceLock 之前固定：改了 productName 后默认 userData 会变，老数据会“消失”；
// 设了 LTM_DATA_DIR 时开发和测试用自己的目录，单实例锁也跟着隔离
const dataRoot = resolveDataRoot(process.env, app.getPath('appData'))
app.setPath('userData', dataRoot)
const paths = buildDataPaths(dataRoot, process.env)
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
initLogger(paths.logs, isDev, process.env)
const log = getLogger('main')

const dbLocation: DatabaseLocation = {
  pgdata: paths.pgdata,
  lockFile: paths.lockFile,
  migrationsFolder: join(app.getAppPath(), 'drizzle')
}

registerLtmSchemePrivileges()

process.on('uncaughtException', (err) => log.error('未捕获的异常', err))
process.on('unhandledRejection', (reason) => log.error('未处理的 Promise 拒绝', reason))

// 启动时的明暗：数据库能打开就按设置，否则跟随浅色
async function initialTheme(dbReady: boolean): Promise<ThemeMode> {
  if (!dbReady) {
    return 'light'
  }
  try {
    const { appearance } = await getSettings()
    if (appearance === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
    return appearance
  } catch (err) {
    log.warn('读取外观设置失败，按浅色启动', err)
    return 'light'
  }
}

// 创建主窗口：开启上下文隔离与沙箱，外部链接交给系统浏览器；标题栏和窗口按钮由界面自己画
function createMainWindow(theme: ThemeMode): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    useContentSize: true,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '诺诺的图床',
    // 任务栏和窗口图标：个人网站的猫尾巴图标
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    backgroundColor: windowBackground(theme),
    titleBarStyle: 'hidden',
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
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`渲染进程退出：${details.reason}（${details.exitCode}）`)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(currentDir, '../renderer/index.html'))
  }
  return win
}

// 扫描状态推给所有窗口
function broadcastScanState(state: ScanStateVO): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcEvent.scanState, state)
    }
  }
}

// 设置里开了“启动时自动扫描”就扫一遍全部目录（对账：外部删掉、改名、新增的文件）
async function autoScanOnStart(): Promise<void> {
  try {
    if ((await getSettings()).autoScan) {
      startScan(null, true)
    }
  } catch (err) {
    log.warn('读取“启动时自动扫描”设置失败，这次不自动扫描', err)
  }
}

// 启动顺序：数据库（打不开也继续，由界面显示原因和“重试”）→ 协议 → IPC → 窗口 → 自动扫描
async function bootstrap(): Promise<void> {
  log.info(`启动，数据目录：${paths.root}`)
  const state = await bootDatabase(dbLocation)
  handleLtmProtocol(paths.thumbs)
  configureScan({ thumbsDir: paths.thumbs, categoryHomeOverride: paths.categoryHomeOverride })
  onScanState(broadcastScanState)
  registerIpcHandlers(paths, dbLocation)
  createMainWindow(await initialTheme(state === 'READY'))
  if (state === 'READY') {
    await autoScanOnStart()
  }
}

// 单实例：同一个数据目录只允许一个进程，第二个实例只负责唤起已有窗口
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) {
        win.restore()
      }
      win.focus()
    }
  })
  app.whenReady().then(bootstrap, (err: unknown) => log.error('应用启动失败', err))
} else {
  app.exit(0)
}

app.on('window-all-closed', () => {
  app.quit()
})

// 退出前关闭数据库并释放锁，确保写入落盘
let closing = false
app.on('will-quit', (event) => {
  if (closing) {
    return
  }
  closing = true
  event.preventDefault()
  // 先让扫描停下（手上的文件写完），再关数据库
  void stopScanAndWait()
    .catch((err: unknown) => log.error('停止扫描失败', err))
    .then(() => shutdownDatabase(paths.lockFile))
    .catch((err: unknown) => log.error('关闭数据库失败', err))
    .finally(() => app.exit(0))
})
