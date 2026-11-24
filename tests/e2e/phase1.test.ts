import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  closeLeftoverApps,
  freshCase,
  killAndWait,
  launchApp,
  setAppearance,
  shot,
  shotPrototype,
  spawnHolder,
  writeLock,
  SHOT_DIR,
  type CaseDirs
} from './support/app'
import { compareShots } from './support/compare'

// 真实数据目录：只看顶层条目的修改时间，确认测试前后没被动过（不打开、不读内容）
const REAL_DATA_DIR = join(process.env.APPDATA ?? '', 'LocalToolManage')

function realDirFingerprint(): string {
  if (!existsSync(REAL_DATA_DIR)) {
    return 'absent'
  }
  return readdirSync(REAL_DATA_DIR)
    .map((n) => `${n}:${statSync(join(REAL_DATA_DIR, n)).mtimeMs}`)
    .sort()
    .join('|')
}

const lockFile = (dirs: CaseDirs): string => join(dirs.data, 'ltm.lock')
const diffRatios: Record<string, number> = {}

let realBefore = ''

beforeAll(() => {
  realBefore = realDirFingerprint()
  mkdirSync(join(SHOT_DIR, 'diff'), { recursive: true })
})

afterEach(async () => {
  await closeLeftoverApps()
})

afterAll(() => {
  writeFileSync(join(SHOT_DIR, 'diff-ratios.json'), JSON.stringify(diffRatios, null, 2))
})

describe('第一阶段：数据隔离、设置、图库打不开', () => {
  const main = freshCase('phase1-main')

  it('首次启动：在隔离目录里建库，锁文件记录应用主进程的真实 PID', async () => {
    const { app, page } = await launchApp(main)
    await expect(page.locator('.title-bar__name').textContent()).resolves.toBe('诺诺的图床')
    await page.waitForSelector('.app-shell')
    expect(await page.locator('.db-error').count()).toBe(0)
    expect(await page.title()).toBe('诺诺的图床')

    const mainPid = await app.evaluate(() => process.pid)
    expect(JSON.parse(readFileSync(lockFile(main), 'utf8')).pid).toBe(mainPid)
    expect(existsSync(join(main.data, 'pgdata', 'PG_VERSION'))).toBe(true)
    expect(readFileSync(join(main.data, 'logs', 'main.log'), 'utf8')).toContain(`启动，数据目录：${main.data}`)
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    expect(userData).toBe(main.data)

    const settings = await page.evaluate(() => window.api.settings.get())
    expect(settings).toMatchObject({ ok: true, data: { appearance: 'light', accent: '#7A63C9' } })
    await shot(page, 'ready-light')

    await setAppearance(page, 'dark')
    const rejected = await page.evaluate(() => window.api.settings.update({ glassBlur: 999 }))
    expect(rejected).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    await app.close()
    expect(existsSync(lockFile(main))).toBe(false)
  })

  it('重启后设置还在；PGlite 残留的假 postmaster.pid 和崩溃残留的锁都不影响打开', async () => {
    const dead = spawnHolder()
    await killAndWait(dead)
    writeLock(main, dead.pid ?? 999999)
    writeFileSync(join(main.data, 'pgdata', 'postmaster.pid'), '-42\n')

    const { app, page } = await launchApp(main)
    await page.waitForSelector('.app-shell')
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    await shot(page, 'ready-dark')
    await setAppearance(page, 'light')
    await app.close()
  })

  it('图库数据被占用：显示原型的“被占用”页面；占用结束后点重试进入主界面', async () => {
    const holder = spawnHolder()
    try {
      writeLock(main, holder.pid ?? 0)
      const { app, page } = await launchApp(main)
      await expect(page.locator('.db-error__title').textContent()).resolves.toBe('图库数据被占用，暂时打不开')
      const appShot = await shot(page, 'dberror-locked-light')
      const protoShot = await shotPrototype('state-dberror')
      diffRatios['dberror-light'] = await compareShots(appShot, protoShot, join(SHOT_DIR, 'diff', 'dberror-light.png'))

      // 占用还在时重试，仍然是被占用
      await page.click('.db-error__retry')
      await page.waitForTimeout(500)
      expect(await page.locator('.db-error__title').textContent()).toBe('图库数据被占用，暂时打不开')

      await killAndWait(holder)
      mkdirSync(main.library, { recursive: true })
      await page.click('.db-error__retry')
      await page.waitForSelector('.app-shell')
      expect(await page.locator('.db-error').count()).toBe(0)
      // 重试也要恢复目录监听；重试后才出现的文件应自动进入图库。
      await sharp({ create: { width: 32, height: 32, channels: 3, background: '#397f84' } }).png().toFile(join(main.library, '重试后新增.png'))
      await expect.poll(() => page.evaluate(async () => {
        const result = await window.api.gallery.list({ view: 'recent', sort: 'new' })
        return result.ok && result.data.items.some(item => item.name === '重试后新增.png' && item.thumb === 'READY')
      }), { timeout: 15_000 }).toBe(true)
      await setAppearance(page, 'dark')
      await app.close()
    } finally {
      await killAndWait(holder)
    }
  })

  it('图库数据被占用（深色）：读不到设置时按上次的外观显示', async () => {
    const holder = spawnHolder()
    try {
      writeLock(main, holder.pid ?? 0)
      const { app, page } = await launchApp(main)
      await page.waitForSelector('.db-error')
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
      const appShot = await shot(page, 'dberror-locked-dark')
      const protoShot = await shotPrototype('state-dberror-dark')
      diffRatios['dberror-dark'] = await compareShots(appShot, protoShot, join(SHOT_DIR, 'diff', 'dberror-dark.png'))
      await app.close()
      // 被占用时应用没有拿到锁，退出时也不能删掉别人的锁
      expect(JSON.parse(readFileSync(lockFile(main), 'utf8')).pid).toBe(holder.pid)
    } finally {
      await killAndWait(holder)
    }
  })

  it('图库数据损坏：显示“损坏”页面，不删除、不重建原有文件', async () => {
    const broken = freshCase('phase1-broken')
    mkdirSync(join(broken.data, 'pgdata'), { recursive: true })
    writeFileSync(join(broken.data, 'pgdata', 'PG_VERSION'), 'garbage\n')
    const { app, page } = await launchApp(broken)
    await expect(page.locator('.db-error__title').textContent()).resolves.toBe('图库数据损坏，暂时打不开')
    await shot(page, 'dberror-broken-light')
    await app.close()
    expect(readFileSync(join(broken.data, 'pgdata', 'PG_VERSION'), 'utf8')).toBe('garbage\n')
    expect(existsSync(lockFile(broken))).toBe(false)
    expect(readFileSync(join(broken.data, 'logs', 'main.log'), 'utf8')).toContain('打开或迁移数据库失败')
  })

  it.skipIf(process.env.LTM_E2E_HIDDEN === '1')('标题栏的窗口按钮：最大化/还原、最小化、关闭（正常退出并释放锁）', async () => {
    const { app, page } = await launchApp(main)
    await page.waitForSelector('.app-shell')
    const state = (): Promise<{ max: boolean; min: boolean }> =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        return { max: w.isMaximized(), min: w.isMinimized() }
      })
    await page.click('.title-bar__win--max')
    await expect.poll(state).toMatchObject({ max: true })
    await page.click('.title-bar__win--max')
    await expect.poll(state).toMatchObject({ max: false })
    await page.click('.title-bar__win--min')
    await expect.poll(state).toMatchObject({ min: true })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())

    const exited = new Promise<void>((done) => app.process().once('exit', () => done()))
    await page.click('.title-bar__win--close')
    await exited
    expect(existsSync(lockFile(main))).toBe(false)
  })

  it('测试全程没有动过真实数据目录', () => {
    expect(realDirFingerprint()).toBe(realBefore)
  })
})
