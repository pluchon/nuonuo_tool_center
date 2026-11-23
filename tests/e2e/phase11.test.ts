import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'

// 测试进程里 sharp 读过的文件会被它的缓存占着（Windows 上删不掉），关掉缓存
sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 主进程里的系统对话框换成直接返回给定路径（测试不弹真对话框）
async function stubDialogs(app: ElectronApplication, open: string, save: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, [o, s]) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [o] })) as unknown as typeof dialog.showOpenDialog
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: s })) as unknown as typeof dialog.showSaveDialog
    },
    [open, save] as const
  )
}

// 设置里某一行
function row(page: Page, label: string) {
  return page.locator('.set-dlg__row').filter({ has: page.locator(`.set-dlg__label:text-is("${label}")`) })
}

// 打开设置并切到某个分类
async function openTab(page: Page, tab: string): Promise<void> {
  if ((await page.locator('.set-dlg').count()) === 0) {
    await page.click('.title-bar__gear')
    await page.waitForSelector('.set-dlg')
  }
  await page.click(`.set-dlg__tab:has-text("${tab}")`)
}

// 根节点上的变量
function rootVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name)
}

describe('第十一阶段：设置', () => {
  it('七个分类、外观即时生效、主题背景和自定义背景、常规开关、缓存清理、导出备份、托盘', async () => {
    const dirs = freshCase('phase11-settings')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    mkdirSync(dirs.library, { recursive: true })
    for (const [i, c] of ['#F6CDD8', '#BBD5EE', '#BFE3D6'].entries()) {
      await sharp({ create: { width: 640, height: 420, channels: 3, background: c } }).jpeg().toFile(join(source, `p${i}.jpg`))
    }
    const bgFile = join(dirs.root, 'my-bg.png')
    await sharp({ create: { width: 3200, height: 2000, channels: 3, background: '#9FC9A8' } }).png().toFile(bgFile)
    const backup = join(dirs.root, 'backup.tar.gz')

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    // 导入用完选文件夹对话框后，再换成选背景图、保存备份
    await stubDialogs(app, bgFile, backup)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 90_000 })

    // 齿轮打开，七个分类
    await page.click('.title-bar__gear')
    await page.waitForSelector('.set-dlg')
    await expect(page.locator('.set-dlg__tab').allTextContents()).resolves.toEqual(['外观', '常规', '图库', 'AI', '数据与缓存', '快捷键', '关于'])
    await shot(page, 'settings-look-light')

    // 主题色即时生效
    await page.click('.set-dlg__swatch[aria-label="绿"]')
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--a') === '#3F8F7B')

    // 主题背景：整窗换成 Halftone，面板玻璃换成纸色；出现“背景淡化”
    await expect(row(page, '背景淡化').count()).resolves.toBe(0)
    await page.click('.set-dlg__bg[aria-label="Halftone"]')
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--look-root-bg').includes('halftone-light'))
    await expect(rootVar(page, '--look-pane-bg')).resolves.toContain('246, 234, 217')
    await page.waitForSelector('.set-dlg__label:text-is("背景淡化")')
    // 拖滑块：先在界面生效，停下后存库
    await row(page, '背景淡化').locator('input').fill('60')
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--look-root-bg').includes('0.60'))
    await page.waitForTimeout(500)
    await expect(page.evaluate(() => window.api.settings.get().then((r) => (r as { data: { backgroundDim: number } }).data.backgroundDim))).resolves.toBe(60)
    await shot(page, 'settings-halftone-light')

    // 组件透明度调到最大：面板变透明，设置弹窗自己的底不变；滑块已拖过的部分是主题色
    const dlgBg = (): Promise<string> => page.evaluate(() => getComputedStyle(document.querySelector('.set-dlg__card')!).backgroundColor)
    const dlgBefore = await dlgBg()
    await row(page, '组件透明度').locator('input').fill('80')
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--look-pane-bg').endsWith('0.08)'))
    await expect(dlgBg()).resolves.toBe(dlgBefore)
    await expect(row(page, '组件透明度').locator('input').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--fill'))).resolves.toBe('100%')
    await row(page, '组件透明度').locator('input').fill('40')

    // 磨砂玻璃关掉，“模糊程度”跟着藏起来
    await row(page, '磨砂玻璃').locator('.set-dlg__switch').click()
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--look-blur') === 'none')
    await expect(row(page, '模糊程度').count()).resolves.toBe(0)
    await row(page, '磨砂玻璃').locator('.set-dlg__switch').click()

    // 自定义背景：选一张图，缩到 2560 存进数据目录
    await page.click('.set-dlg__bg[aria-label="选一张背景图"]')
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--look-root-bg').includes('ltm://bg/custom-'))
    const saved = readdirSync(join(dirs.data, 'backgrounds'))
    expect(saved).toHaveLength(1)
    expect((await sharp(join(dirs.data, 'backgrounds', saved[0])).metadata()).width).toBe(2560)
    // 换两次：用着的是最新那张；旧图界面里还占着的，下次启动时删掉（最后重启时检查）
    const current = async (): Promise<string> => (await rootVar(page, '--look-root-bg')).match(/custom-[0-9]+\.webp/)?.[0] ?? ''
    await page.click('.set-dlg__bg-swap')
    await page.waitForFunction((old) => !document.documentElement.style.getPropertyValue('--look-root-bg').includes(old), saved[0])
    const second = await current()
    await page.click('.set-dlg__bg-swap')
    await page.waitForFunction((old) => !document.documentElement.style.getPropertyValue('--look-root-bg').includes(old), second)
    const latest = await current()
    expect(readdirSync(join(dirs.data, 'backgrounds'))).toContain(latest)
    await shot(page, 'settings-custom-light')
    await page.click('.set-dlg__bg[aria-label="默认"]')

    // 常规：关掉删除前确认，Delete 直接删（可撤销）
    await openTab(page, '常规')
    await shot(page, 'settings-general-light')
    await row(page, '删除前确认').locator('.set-dlg__switch').click()
    await expect(row(page, '删除前确认').locator('.set-dlg__switch').getAttribute('aria-checked')).resolves.toBe('false')
    // 开机自动启动在测试环境只存设置、不碰系统登记
    await row(page, '开机自动启动').locator('.set-dlg__switch').click()
    await expect(row(page, '开机自动启动').locator('.set-dlg__switch').getAttribute('aria-checked')).resolves.toBe('true')
    await expect(app.evaluate(({ app: a }) => a.getLoginItemSettings().openAtLogin)).resolves.toBe(false)
    await row(page, '开机自动启动').locator('.set-dlg__switch').click()

    // 图库：格式至少留一种；测试环境的类目录位置由环境变量定，不能改
    await openTab(page, '图库')
    await page.waitForFunction(() => !!document.querySelector('.set-dlg__path')?.textContent?.includes('library'))
    await expect(row(page, '类目录保存的位置').locator('.set-dlg__btn').isDisabled()).resolves.toBe(true)
    await page.click('.set-dlg__chip:text-is("RAW")')
    await expect(page.locator('.set-dlg__chip:text-is("RAW")').getAttribute('aria-pressed')).resolves.toBe('false')
    await page.click('.set-dlg__chip:text-is("RAW")')
    // 跳过小图：像数字的选项（"10"）存进库再读回来还是选中的
    await row(page, '跳过小图').locator('.set-dlg__seg-btn:has-text("小于 10 KB")').click()
    await page.waitForSelector('.set-dlg__seg-btn[aria-checked="true"]:has-text("小于 10 KB")')
    await expect(page.evaluate(() => window.api.settings.get().then((r) => (r as { data: { skipSmall: string } }).data.skipSmall))).resolves.toBe('10')
    await row(page, '跳过小图').locator('.set-dlg__seg-btn:has-text("不跳过")').click()
    await shot(page, 'settings-library-light')

    // 数据与缓存：缓存大小、清理（只删用不到的）、导出备份
    await openTab(page, '数据与缓存')
    await page.waitForFunction(() => /KB|MB/.test(document.querySelector('.set-dlg__row .set-dlg__value')?.textContent ?? ''))
    const thumbs = join(dirs.data, 'thumbs')
    const before = readdirSync(thumbs).length
    // 放一个库里没有的缩略图，清理时只删它
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).webp().toFile(join(thumbs, `${'0'.repeat(64)}.webp`))
    await row(page, '缩略图缓存').locator('.set-dlg__btn').click()
    await page.waitForSelector('.app-toast:has-text("清理了 1 张用不到的缩略图")')
    expect(readdirSync(thumbs).length).toBe(before)
    await row(page, '图库数据').locator('.set-dlg__btn').click()
    await page.waitForSelector('.app-toast:has-text("已导出备份到")')
    expect(statSync(backup).size).toBeGreaterThan(1000)
    await shot(page, 'settings-data-light')

    await openTab(page, '快捷键')
    await expect(page.locator('.set-dlg__row').count()).resolves.toBe(18)
    await openTab(page, '关于')
    await expect(row(page, '图片总数').locator('.set-dlg__value').textContent()).resolves.toBe('3 张')
    await page.click('.set-dlg__upd')
    await page.waitForSelector('.set-dlg__upd-text:has-text("暂未开放在线更新")')
    await shot(page, 'settings-about-light')

    // Esc 关闭
    await page.keyboard.press('Escape')
    await page.waitForSelector('.set-dlg', { state: 'detached' })

    // 删除前确认关了：Delete 直接删，提示条可撤销
    await page.click('.tile:has-text("p0.jpg")')
    await page.keyboard.press('Delete')
    await page.waitForSelector('.app-toast:has-text("撤销")')
    await expect(page.locator('.confirm-dlg').count()).resolves.toBe(0)
    await page.click('.app-toast button:has-text("撤销")')
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3)

    // 关闭窗口时最小化到托盘：点关闭只是藏起来
    await openTab(page, '常规')
    await row(page, '关闭窗口时').locator('.set-dlg__seg-btn:has-text("最小化到托盘")').click()
    await page.keyboard.press('Escape')
    await page.click('.title-bar__win--close')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)

    // 深色 + 主题背景
    await setAppearance(page, 'dark')
    await openTab(page, '外观')
    await page.click('.set-dlg__bg[aria-label="Plotter"]')
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--look-root-bg').includes('plotter-dark'))
    await shot(page, 'settings-plotter-dark')
    await page.keyboard.press('Escape')
    await shot(page, 'main-plotter-dark')
    expect(existsSync(backup)).toBe(true)
    await app.close()

    // 重启：没删掉的旧背景图清掉，只剩设置里那张
    const again = await launchApp(dirs)
    await again.page.waitForSelector('.app-shell')
    const kept = (await again.page.evaluate(() => window.api.settings.get())) as { data: { customBackground: string } }
    await expect.poll(() => readdirSync(join(dirs.data, 'backgrounds'))).toEqual([kept.data.customBackground])
    expect(kept.data.customBackground).toBe(latest)
    await again.app.close()
  })

  it('AI 设置默认读取环境变量，切换分类时加密自动保存，重启后可以恢复默认', async () => {
    const dirs = freshCase('phase11-ai-settings')
    const keyFile = join(dirs.data, 'ai-credentials.enc')
    const overrides = { ALIYUN_ACCESS_KEY_ID: 'fixture-environment-id' }
    const { app, page } = await launchApp(dirs, overrides)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.waitForSelector('.app-shell')
    await page.locator('.side-nav__item').filter({ hasText: '诺诺助手' }).click()
    await page.waitForSelector('.assistant__nokey')
    await openTab(page, 'AI')
    await page.waitForSelector('input[placeholder="使用环境变量"]')
    const dashscope = page.getByLabel('百炼 API Key', { exact: true })
    const accessId = page.getByLabel('AccessKey ID', { exact: true })
    const accessSecret = page.getByLabel('AccessKey Secret', { exact: true })
    const save = page.getByRole('button', { name: '保存', exact: true })
    expect(await page.getByRole('tab', { name: 'AI', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await dashscope.getAttribute('placeholder')).toBe('未设置')
    expect(await accessId.getAttribute('placeholder')).toBe('使用环境变量')
    expect(await accessId.inputValue()).toBe('')
    expect(await save.count()).toBe(0)
    expect(await dashscope.getAttribute('type')).toBe('password')

    await dashscope.fill(' fixture-saved-api-key ')
    await accessId.fill('fixture-saved-access-id')
    await accessSecret.fill('fixture-saved-access-secret')
    expect(existsSync(keyFile)).toBe(false)
    await openTab(page, '外观')
    await openTab(page, 'AI')
    await page.waitForSelector('input[aria-label="AccessKey Secret"][placeholder="已保存"]')
    expect(await dashscope.inputValue()).toBe('')
    expect(await page.evaluate(() => window.api.ai.status())).toEqual({ ok: true, data: { ready: true } })
    expect(await page.evaluate(() => window.api.settings.getAiCredentials())).toEqual({
      ok: true, data: { dashscopeApiKey: 'saved', aliyunAccessKeyId: 'saved', aliyunAccessKeySecret: 'saved' }
    })
    const ciphertext = readFileSync(keyFile)
    expect(ciphertext.includes(Buffer.from('fixture-saved-api-key'))).toBe(false)
    const plaintext = await app.evaluate(async ({ safeStorage }, bytes) =>
      (await safeStorage.decryptStringAsync(Buffer.from(bytes))).result, [...ciphertext])
    expect(JSON.parse(plaintext)).toEqual({
      dashscopeApiKey: 'fixture-saved-api-key', aliyunAccessKeyId: 'fixture-saved-access-id', aliyunAccessKeySecret: 'fixture-saved-access-secret'
    })
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭', exact: true }).click()
    await page.waitForSelector('.assistant__welcome')
    expect(errors).toEqual([])
    await app.close()

    const reopened = await launchApp(dirs, overrides)
    await reopened.page.waitForSelector('.app-shell')
    await setAppearance(reopened.page, 'dark')
    await openTab(reopened.page, 'AI')
    for (const label of ['百炼 API Key', 'AccessKey ID', 'AccessKey Secret']) {
      await reopened.page.getByRole('button', { name: `恢复默认：${label}` }).click()
    }
    await reopened.page.waitForSelector('input[aria-label="AccessKey Secret"][placeholder="未设置"]')
    expect(await reopened.page.getByLabel('AccessKey ID', { exact: true }).getAttribute('placeholder')).toBe('使用环境变量')
    expect(await reopened.page.evaluate(() => window.api.ai.status())).toEqual({ ok: true, data: { ready: false } })
    expect(existsSync(keyFile)).toBe(false)
    await reopened.app.close()
  })

  it('AI 密钥自动保存可处理缓慢写入、无效输入、清空草稿和关闭窗口', async () => {
    const dirs = freshCase('phase11-ai-autosave')
    const keyFile = join(dirs.data, 'ai-credentials.enc')
    const overrides = { ALIYUN_ACCESS_KEY_ID: 'fixture-environment-id' }
    const { app, page } = await launchApp(dirs, overrides)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await app.evaluate(({ safeStorage }) => {
      const encrypt = safeStorage.encryptStringAsync.bind(safeStorage)
      safeStorage.encryptStringAsync = async (text) => {
        if (text.includes('fixture-slow-id')) await new Promise((done) => setTimeout(done, 700))
        if (text.includes('fixture-disk-error')) throw new Error('模拟写入失败')
        return encrypt(text)
      }
    })
    await openTab(page, 'AI')
    const accessId = page.getByLabel('AccessKey ID', { exact: true })
    const accessSecret = page.getByLabel('AccessKey Secret', { exact: true })
    await page.waitForSelector('input[placeholder="使用环境变量"]')
    await accessId.fill('    ')
    await accessId.press('Enter')
    expect(await accessId.inputValue()).toBe('')
    expect(existsSync(keyFile)).toBe(false)

    await accessId.fill('fixture-slow-id')
    await accessId.press('Enter')
    await accessId.fill('fixture-latest-id')
    await accessId.press('Enter')
    await expect.poll(() => accessId.inputValue()).toBe('')
    const readSaved = async (desktop: ElectronApplication) => JSON.parse(await desktop.evaluate(async ({ safeStorage }, bytes) =>
      (await safeStorage.decryptStringAsync(Buffer.from(bytes))).result, [...readFileSync(keyFile)]))
    expect(await readSaved(app)).toEqual({ aliyunAccessKeyId: 'fixture-latest-id' })

    await accessId.fill('invalid key')
    await accessId.press('Enter')
    await page.getByText('AI 密钥格式不正确', { exact: true }).waitFor()
    expect(await readSaved(app)).toEqual({ aliyunAccessKeyId: 'fixture-latest-id' })
    await page.getByRole('button', { name: '知道了' }).click()
    await accessId.fill('x'.repeat(4097))
    await accessId.press('Enter')
    await page.getByText('AI 密钥格式不正确', { exact: true }).waitFor()
    await page.getByRole('button', { name: '知道了' }).click()
    await accessId.fill('fixture-disk-error')
    await accessId.press('Enter')
    await page.getByText('无法保存 AI 密钥', { exact: true }).waitFor()
    expect(await readSaved(app)).toEqual({ aliyunAccessKeyId: 'fixture-latest-id' })
    await accessId.fill('')

    // 输入最后一个字段后直接关闭窗口，由正常退出流程等待写入结束。
    await accessSecret.fill('fixture-key-on-exit')
    await app.close()
    const reopened = await launchApp(dirs, overrides)
    expect(await readSaved(reopened.app)).toEqual({ aliyunAccessKeyId: 'fixture-latest-id', aliyunAccessKeySecret: 'fixture-key-on-exit' })
    await reopened.app.close()
  })
})
