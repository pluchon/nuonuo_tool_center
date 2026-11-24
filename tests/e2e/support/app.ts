import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { _electron, type ElectronApplication, type Page } from 'playwright'

// 端到端测试的数据全部放在这里，绝不碰真实数据目录
export const E2E_ROOT = 'D:\\ltm-dev\\e2e'
// 开发和测试共用的模型目录
export const MODEL_DIR = 'D:\\ltm-dev\\models'
export const PROJECT_ROOT = resolve('.')
export const SHOT_DIR = resolve('test-output/phase1')

// 一个测试场景的目录：数据目录和类目录都在里面
export interface CaseDirs {
  root: string
  data: string
  library: string
}

// 清空并新建场景目录；目录必须在 E2E_ROOT 下面
export function freshCase(name: string): CaseDirs {
  const root = join(E2E_ROOT, name)
  if (!root.toLowerCase().startsWith(E2E_ROOT.toLowerCase() + '\\')) {
    throw new Error(`测试目录不在 ${E2E_ROOT} 下：${root}`)
  }
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return { root, data: join(root, 'data'), library: join(root, 'library') }
}

// 本次测试启动过、可能还没关掉的应用
const openApps = new Set<ElectronApplication>()

// 关掉测试中途失败时还开着的应用（正常退出，让数据库落盘、释放锁），避免挡住下一个用例的单实例锁
export async function closeLeftoverApps(): Promise<void> {
  for (const app of [...openApps]) {
    openApps.delete(app)
    await app.close().catch(() => undefined)
  }
}

// 用构建产物启动应用，数据目录指向场景目录
export async function launchApp(dirs: CaseDirs, overrides: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  if (!existsSync(join(PROJECT_ROOT, 'out/main/index.js'))) {
    throw new Error('还没有构建产物，先运行 npm run build')
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') {
      env[k] = v
    }
  }
  // 删除的文件挪进场景目录下的 trash，不进系统回收站
  // 本地分级模型用开发目录里共用的那份，不在每个场景里各下载一次
  Object.assign(env, {
    // 禁止继承真实云端凭证，显式空白也会阻止回退到 Windows 用户环境变量。
    DASHSCOPE_API_KEY: ' ',
    ALIYUN_ACCESS_KEY_ID: ' ',
    ALIYUN_ACCESS_KEY_SECRET: ' ',
    ...overrides,
    LTM_DATA_DIR: dirs.data,
    LTM_CATEGORY_HOME: dirs.library,
    LTM_LOG_LEVEL: 'info',
    LTM_FAKE_TRASH_DIR: join(dirs.root, 'trash'),
    LTM_MODEL_DIR: overrides.LTM_MODEL_DIR ?? env.LTM_MODEL_DIR ?? MODEL_DIR
  })
  const entry = env.LTM_E2E_HIDDEN === '1' ? join(PROJECT_ROOT, 'tests/e2e/support/hiddenWindow.cjs') : PROJECT_ROOT
  const app = await _electron.launch({ executablePath: electronPath as unknown as string, args: [entry], env })
  openApps.add(app)
  app.once('close', () => openApps.delete(app))
  const page = await app.firstWindow()
  await page.waitForSelector('.app-root')
  await pinViewport(app, page)
  return { app, page }
}

// 启动一个名字是 electron.exe 的空转进程，用来扮演“另一个正在用图库数据的应用”
export function spawnHolder(): ChildProcess {
  return spawn(electronPath as unknown as string, ['-e', 'setTimeout(() => {}, 300000)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true
  })
}

// 把锁文件写成被某个进程持有
export function writeLock(dirs: CaseDirs, pid: number): void {
  mkdirSync(dirs.data, { recursive: true })
  writeFileSync(join(dirs.data, 'ltm.lock'), JSON.stringify({ pid, exe: 'electron.exe', startedAt: new Date().toISOString() }))
}

// 结束进程并等它真的退出；被信号结束的进程 exitCode 是 null、signalCode 有值，两个都要看
export async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((done) => {
    child.once('exit', () => done())
    child.kill()
  })
}

// 把窗口内容区固定成原型画板的 1280×820：创建窗口时的尺寸在高分屏上会差一两个像素，窗口显示后再设一次才准
export async function pinViewport(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 820))
  await page.waitForFunction(() => window.innerWidth === 1280 && window.innerHeight === 820)
}

// 改外观设置并重新加载页面：界面读设置时会把外观写进本机缓存，“打不开”页面靠这个缓存决定深浅
export async function setAppearance(page: Page, appearance: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => window.api.settings.update({ appearance: value }), appearance)
  await page.reload()
  await page.waitForSelector('.app-shell')
  await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, appearance === 'dark')
}

export async function captureWindow(page: Page, file: string, app?: ElectronApplication): Promise<void> {
  if (process.env.LTM_E2E_HIDDEN !== '1' || !app) {
    await page.screenshot({ path: file })
    return
  }
  await page.evaluate(async () => {
    await document.fonts.ready
    const frame = () => new Promise<void>(done => requestAnimationFrame(() => done()))
    await frame()
    const transitions = document.getAnimations().filter(animation => {
      const duration = animation.effect?.getComputedTiming().endTime
      return animation.playState === 'running' && typeof duration === 'number' && duration <= 500
    })
    await Promise.allSettled(transitions.map(animation => animation.finished))
    await frame()
  })
  const win = await app.browserWindow(page)
  try {
    const png = await win.evaluate(async (w) => {
      const image = await w.webContents.capturePage(undefined, { stayHidden: true })
      if (image.isEmpty()) throw new Error('未能截取测试窗口')
      return image.toPNG().toString('base64')
    })
    writeFileSync(file, Buffer.from(png, 'base64'))
  } finally {
    await win.dispose()
  }
}

// 截应用窗口
export async function shot(page: Page, name: string): Promise<string> {
  const file = join(SHOT_DIR, 'app', `${name}.png`)
  mkdirSync(join(SHOT_DIR, 'app'), { recursive: true })
  await captureWindow(page, file, [...openApps].find(app => app.windows().includes(page)))
  return file
}

// 从仓库里的原型生成当前预设，首次测试和修改原型后都使用同一份基准。
export async function shotPrototype(name: string): Promise<string> {
  execFileSync(process.execPath, [resolve('docs/prototype/tools/render.cjs'), '--preset', name])
  const html = resolve(`test-output/prototype/${name}.html`)
  const file = join(SHOT_DIR, 'proto', `${name}.png`)
  mkdirSync(join(SHOT_DIR, 'proto'), { recursive: true })
  const proto = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [resolve('tests/e2e/support/protoWindow.cjs')],
    env: { ...(process.env as Record<string, string>), PROTO_FILE: html }
  })
  const page = await proto.firstWindow()
  await page.waitForLoadState('load')
  await pinViewport(proto, page)
  await page.waitForTimeout(1200)
  try {
    await captureWindow(page, file, proto)
  } finally {
    await proto.close()
  }
  return file
}
