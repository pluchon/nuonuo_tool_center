import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IpcEvent, type FileOpDoneVO, type ScanStateVO, type ThemeMode } from '@shared/api'
import { buildDataPaths, resolveDataRoot } from './config/paths'
import { getLogger, initLogger } from './common/logger'
import { registerIpcHandlers } from './ipc'
import { handleLtmProtocol, registerLtmSchemePrivileges } from './protocol/ltmProtocol'
import { bootDatabase, shutdownDatabase, type DatabaseLocation } from './services/databaseService'
import { configureFileOps, flushPendingDeletes, recoverFileOps } from './services/fileOps/fileOpsService'
import { configureTransfer } from './services/fileOps/transferService'
import { configureFolderOps } from './services/fileOps/folderOpsService'
import { originalPathOf } from './services/galleryService'
import { configureScan, onScanState, requeueScan, startScan, stopScanAndWait } from './services/scan/scanService'
import { configureWatch, stopWatching, syncWatching } from './services/scan/watchService'
import { getSettings } from './services/settingsService'
import { windowBackground } from './window/windowControl'
import { attachCloseBehavior, markQuitting } from './window/trayControl'
import { applySystemSettings } from './window/systemSettings'
import { pruneBackgrounds } from './services/systemService'

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
  // Windows 用多尺寸的 ico（小尺寸更清楚），其它系统用 png
  const iconPath = join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
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
    icon: iconPath,
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
  attachCloseBehavior(win, iconPath)
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

// 放进回收站的方式：正常是系统回收站；端到端测试设了 LTM_FAKE_TRASH_DIR 时挪进那个文件夹（不往真回收站里塞测试图）
function trashFunction(): (path: string) => Promise<void> {
  const fake = process.env.LTM_FAKE_TRASH_DIR
  if (!fake) {
    return (path) => shell.trashItem(path)
  }
  return async (path) => {
    await mkdir(fake, { recursive: true })
    await rename(path, join(fake, `${Date.now()}-${basename(path)}`))
  }
}

// 文件操作执行完推给所有窗口（删不掉的要提示）
function broadcastFileOpDone(result: FileOpDoneVO): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcEvent.fileOpDone, result)
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
  handleLtmProtocol(paths.thumbs, paths.backgrounds, originalPathOf)
  configureScan({ thumbsDir: paths.thumbs, categoryHomeOverride: paths.categoryHomeOverride })
  // 扫描做完（目录可能有增删、移动硬盘接回来了）后重新对一遍监听的目录
  let scanning = false
  onScanState((state) => {
    broadcastScanState(state)
    if (scanning && !state.progress) {
      void syncWatching()
    }
    scanning = state.progress !== null
  })
  configureWatch(requeueScan)
  configureFileOps({ trash: trashFunction(), onDone: broadcastFileOpDone })
  configureTransfer(paths.categoryHomeOverride)
  configureFolderOps(paths.categoryHomeOverride)
  registerIpcHandlers(paths, dbLocation)
  if (state === 'READY') {
    // 上次没做完的文件操作（崩溃、断电）先按日志补做，再扫描
    await recoverFileOps().catch((err: unknown) => log.error('补做上次的文件操作失败', err))
  }
  if (state === 'READY') {
    // 关闭窗口时的行为按设置来（开机自动启动只在设置里改的时候才登记，这里不碰）
    await getSettings()
      .then(async (s) => {
        applySystemSettings(s, {})
        // 上次换背景时还在显示、没删掉的旧图
        await pruneBackgrounds(paths.backgrounds, s.customBackground)
      })
      .catch((err: unknown) => log.warn('读取关闭窗口设置失败，按退出应用处理', err))
  }
  createMainWindow(await initialTheme(state === 'READY'))
  if (state === 'READY') {
    await autoScanOnStart()
    await syncWatching()
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

// 真正要退出了（托盘菜单、系统关机、测试关应用）：关窗口不再藏到托盘
app.on('before-quit', () => markQuitting())

// 退出前关闭数据库并释放锁，确保写入落盘
let closing = false
app.on('will-quit', (event) => {
  if (closing) {
    return
  }
  closing = true
  event.preventDefault()
  // 等着进回收站的删除马上执行，再让扫描停下（手上的文件写完），最后关数据库
  void stopWatching()
    .then(() => flushPendingDeletes())
    .catch((err: unknown) => log.error('退出前执行删除失败', err))
    .then(() => stopScanAndWait())
    .catch((err: unknown) => log.error('停止扫描失败', err))
    .then(() => shutdownDatabase(paths.lockFile))
    .catch((err: unknown) => log.error('关闭数据库失败', err))
    .finally(() => app.exit(0))
})
