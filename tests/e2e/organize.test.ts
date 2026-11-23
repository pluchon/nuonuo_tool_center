import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'
import { bailianRequests, launchWithMockBailian } from './support/mockBailian'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 画一张带字的测试图（不用任何真实图片）
async function makeImage(file: string, text: string, bg: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="100%" height="100%" fill="${bg}"/><circle cx="700" cy="160" r="90" fill="#F2B84B"/><text x="60" y="330" font-size="80" font-family="Microsoft YaHei" fill="#333">${text}</text></svg>`
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file)
}

describe('一键整理', () => {
  it('立即显示估算占位，关闭重开后只接受本次结果，失败后可以重试', async () => {
    const { app, page } = await launchWithMockBailian(freshCase('organize-estimate-delay'))
    await page.reload()
    await app.evaluate(({ ipcMain }) => {
      let seq = 0
      ipcMain.removeHandler('organize:estimate')
      ipcMain.handle('organize:estimate', () => new Promise((resolve) => {
        ipcMain.once(`test-estimate-${++seq}`, resolve)
      }))
    })
    const deliver = async (seq: number, count: number | null): Promise<void> => {
      const event = `test-estimate-${seq}`
      await expect.poll(() => app.evaluate(({ ipcMain }, name) => ipcMain.listenerCount(name), event)).toBe(1)
      const response = count === null ? { ok: false, code: 'INTERNAL', message: '估算失败' } :
        { ok: true, data: { ratingLeft: 0, toLook: count, tokens: 500, yuan: 0.01 } }
      await app.evaluate(({ ipcMain }, { event, response }) => ipcMain.emit(event, response), { event, response })
    }
    const dialog = page.getByRole('dialog', { name: '一键整理' })
    const start = dialog.getByRole('button', { name: '开始整理' })
    await page.locator('.organize').click()
    await dialog.locator('[aria-busy="true"]').waitFor()
    expect(await dialog.locator('.org-dlg__spinner').count()).toBe(3)
    expect(await start.isDisabled()).toBe(true)
    await dialog.getByRole('button', { name: '暂时不整理' }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.organize').click()
    await deliver(1, 99)
    await deliver(2, null)
    await page.locator('.app-toast').filter({ hasText: '估算失败' }).waitFor()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.organize').click()
    await dialog.locator('[aria-busy="true"]').waitFor()
    await deliver(3, 8)
    await dialog.locator('[aria-busy="false"]').waitFor()
    expect(await dialog.locator('.org-dlg__stat--look b').innerText()).toBe('8')
    expect(await start.isEnabled()).toBe(true)
    expect(await bailianRequests(app)).toHaveLength(0)
    await app.close()
  })

  it('整理看图时只有一个停止入口，缺少密钥时保留批量任务并显示原因', async () => {
    const dirs = freshCase('organize-queue-controls')
    const thumbs = join(dirs.data, 'thumbs')
    mkdirSync(thumbs, { recursive: true })
    for (const char of ['a', 'b', 'c']) {
      await sharp({ create: { width: 32, height: 32, channels: 3, background: '#CFE3F5' } }).webp().toFile(join(thumbs, `${char.repeat(64)}.webp`))
    }
    await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
    try {
      await getDatabase().pg.exec(`
        INSERT INTO app_setting (key, value) VALUES
          ('ai.organize', '{"phase":"LOOKING","plan":null,"error":null}'),
          ('ai.organizeLookFrom', '"2000-01-01T00:00:00.000Z"'), ('autoScan', 'true');
        INSERT INTO image (content_hash, display_name, format, byte_size, rating, rating_source, thumb_ready) VALUES
          (repeat('a', 64), '排队图', 'JPG', 1, 'GENERAL', 'MODEL', 1),
          (repeat('b', 64), '批量图', 'JPG', 1, 'GENERAL', 'MODEL', 1),
          (repeat('c', 64), '失败图', 'JPG', 1, 'GENERAL', 'MODEL', 1),
          (repeat('d', 64), '已看图', 'JPG', 1, 'GENERAL', 'MODEL', 1);
        INSERT INTO ai_job (kind, image_id, status, remote_id) VALUES
          ('LOOK', 1, 'QUEUED', NULL), ('LOOK', 2, 'RUNNING', 'test-batch'),
          ('LOOK', 3, 'FAILED', NULL), ('LOOK', 4, 'DONE', NULL);
      `)
    } finally {
      await closeDatabase()
    }

    const first = await launchApp(dirs)
    await first.page.getByRole('button', { name: '看了 1 / 4 张图', exact: true }).waitFor()
    expect(await first.page.evaluate(() => window.api.scan.getState())).toMatchObject({ ok: true, data: { progress: null, last: null } })
    await first.app.close()

    const { app, page } = await launchApp(dirs)
    await page.getByRole('button', { name: '看了 1 / 4 张图', exact: true }).waitFor()
    expect(await page.evaluate(() => window.api.scan.getState())).toMatchObject({ ok: true, data: { progress: null, last: null } })
    const spinner = page.locator('.organize__spinner')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    await page.locator('.look__pill').click()
    await page.locator('.look__row').filter({ hasText: '批量图' }).getByText('批量任务待配置密钥').waitFor()
    await page.locator('.look__row').filter({ hasText: '排队图' }).getByText('等待配置密钥').waitFor()
    expect(await page.locator('.look__cancel').count()).toBe(0)
    expect(await page.evaluate(() => window.api.scan.getState())).toMatchObject({ ok: true, data: { progress: null, last: null } })
    const blocked = await page.evaluate(() => window.api.look.cancelAll())
    expect(blocked).toMatchObject({ ok: false, code: 'CONFLICT' })

    await page.locator('.organize').click()
    await page.getByRole('button', { name: '停止整理', exact: true }).click()
    await page.locator('.organize').filter({ hasText: '一键整理' }).waitFor()
    await expect.poll(() => page.evaluate(() => window.api.scan.getState()), { timeout: 10_000 }).toMatchObject({
      ok: true, data: { progress: null, last: { auto: true, stopped: false } }
    })
    expect(await spinner.count()).toBe(0)
    await page.locator('.look__pill').click()
    await page.getByRole('button', { name: '取消看图任务' }).click()
    await page.locator('.look__row').filter({ hasText: '排队图' }).waitFor({ state: 'detached' })
    await page.locator('.look__row').filter({ hasText: '批量图' }).getByText('批量任务待配置密钥').waitFor()
    expect(await page.locator('.look__cancel').count()).toBe(0)
    await app.close()
  }, 60_000)

  it('被拦截的图片显示在普通 AI 建议，原有 R-18 开关可以完成复核', async () => {
    const dirs = freshCase('organize-r18-review')
    const source = join(dirs.root, 'pics')
    const thumbs = join(dirs.data, 'thumbs')
    mkdirSync(source, { recursive: true })
    mkdirSync(thumbs, { recursive: true })
    const hash = 'a'.repeat(64)
    const file = join(source, '复核示例.jpg')
    await makeImage(file, '复核示例', '#CFE3F5')
    await sharp(file).resize(80).webp().toFile(join(thumbs, `${hash}.webp`))
    await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
    try {
      const { pg } = getDatabase()
      await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', '测试目录', $1)`, [source])
      await pg.exec(`
        INSERT INTO app_setting (key, value) VALUES ('autoScan', 'false');
        INSERT INTO image (content_hash, format, byte_size, width, height, thumb_ready, is_r18, rating, rating_source)
          VALUES (repeat('a', 64), 'JPG', 1, 900, 600, 1, true, 'GENERAL', 'MODEL');
        INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, '复核示例.jpg', now());
        INSERT INTO image_ai_result (image_id, kind, model, result, field_status)
          VALUES (1, 'IDENTIFY', 'test', '{}', '{"r18Review":"PENDING"}');
        INSERT INTO ai_job (kind, image_id, status, error) VALUES ('LOOK', 1, 'FAILED', '云端内容审核未通过');
      `)
    } finally {
      await closeDatabase()
    }
    const { app, page } = await launchApp(dirs)
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.locator('.tile').click()
    await page.getByText('云端内容审核未通过', { exact: true }).waitFor()
    await expect.poll(() => page.evaluate(() => window.api.look.state())).toMatchObject({ ok: true, data: { count: 0, rows: [] } })
    const switchControl = page.getByRole('switch', { name: '标为 R-18' })
    expect(await switchControl.getAttribute('aria-checked')).toBe('true')
    await switchControl.click()
    await page.locator('.tile').waitFor({ state: 'detached' })
    const detail = await page.evaluate(() => window.api.gallery.detail(1))
    expect(detail).toMatchObject({ ok: true, data: { isR18: false } })
    await app.close()
  }, 60_000)

  it('本地分级完成后生成整理方案，批准后按组采用并复制进类目录', async () => {
    const dirs = freshCase('organize')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await makeImage(join(source, 'meme1.jpg'), '好椰', '#F6E7C8')
    await makeImage(join(source, 'meme2.jpg'), '晚安', '#CFE3F5')
    await makeImage(join(source, 'meme3.jpg'), '早上好', '#E2F4EE')

    const { app, page } = await launchWithMockBailian(dirs)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // 记下本地分级推过来的进度
    await page.evaluate(() => {
      const w = window as unknown as { __rating: Array<{ running: boolean; done: number; total: number }> }
      w.__rating = []
      window.api.rating.onProgress((p) => w.__rating.push(p))
    })
    await importFolder(app, page, source)
    // 先观察到分级事件，避免截图耗时跨过短暂的分级状态。
    await page.waitForFunction(() => (window as unknown as { __rating: Array<{ running: boolean }> }).__rating.some((p) => p.running))
    const clickedWhileWaiting = await page.evaluate(() => {
      const b = document.querySelector<HTMLButtonElement>('.organize--waiting')
      b?.click()
      return b !== null
    })
    if (clickedWhileWaiting) {
      await page.waitForSelector('.app-toast:has-text("本地分级判完才能整理")')
      await expect(page.locator('.org-dlg').count()).resolves.toBe(0)
    }
    if (await page.locator('.rating-pill').isVisible()) await shot(page, 'organize-light-rating')
    await page.waitForSelector('.rating-pill', { state: 'detached', timeout: 120_000 })
    await expect(page.locator('.organize--waiting').count()).resolves.toBe(0)
    const progress = await page.evaluate(() => (window as unknown as { __rating: Array<{ running: boolean; done: number; total: number }> }).__rating)
    expect(progress.some((p) => p.running && p.total === 3)).toBe(true)
    expect(progress[progress.length - 1]).toMatchObject({ running: false, done: 3 })

    // 新图看完后，“AI 建议”有 3 张。
    await page.waitForFunction(
      () => {
        const row = [...document.querySelectorAll('.side-nav__item')].find((e) => e.querySelector('.side-nav__label')?.textContent === 'AI 建议')
        return row?.querySelector('.side-nav__count')?.textContent === '3'
      },
      null,
      { timeout: 60_000 }
    )

    // 一键整理直接请求方案，已有的看图结果可以复用。
    await page.click('.organize')
    await page.waitForSelector('.org-dlg__stat:has-text("待看")')
    // 一排“待看 / token / 花费”各一行；没有副标题、提示和脚注
    await expect(page.locator('.org-dlg__stat span').allTextContents()).resolves.toEqual(['待看', 'token', '花费'])
    await expect(page.locator('.org-dlg__sub, .org-dlg__note, .org-dlg__foot').count()).resolves.toBe(0)
    await expect(page.locator('.org-dlg__stat b').first().textContent()).resolves.toBe('0')
    await page.waitForTimeout(300)
    await shot(page, 'organize-light-confirm')
    await page.click('.org-dlg__go')
    await page.waitForSelector('.org-dlg__card--plan', { timeout: 150_000 })
    const requests = await bailianRequests(app)
    expect(requests.filter((route) => route === 'responses')).toHaveLength(3)
    expect(requests.filter((route) => route === 'completions')).toHaveLength(1)
    await page.waitForTimeout(400)
    await expect(page.locator('.org-dlg__error-text').count()).resolves.toBe(0)
    expect(await page.locator('.org-dlg__folder').count()).toBeGreaterThan(0)
    // 方案弹窗只有标题，不放说明
    await expect(page.locator('.org-dlg__sub').count()).resolves.toBe(0)
    await shot(page, 'organize-light-plan')
    // 换成深色：页面重新加载，方案待确认会再弹出来
    await setAppearance(page, 'dark')
    await page.waitForSelector('.org-dlg__card--plan')
    await page.waitForTimeout(400)
    await shot(page, 'organize-dark-plan')
    await page.click('.org-dlg__go')
    await page.waitForSelector('.org-dlg', { state: 'detached' })
    await page.waitForSelector('.app-toast:has-text("在“AI 建议”里慢慢审"), .app-toast:has-text("没有能分进")')

    // AI 建议视图：按目标类目录分组，组头一起采用
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.waitForSelector('.image-grid__head--dir')
    await page.click('.tile >> nth=0')
    await page.waitForSelector('.sugg__row:has-text("放进")')
    await page.waitForTimeout(500)
    await shot(page, 'organize-dark-review')
    await setAppearance(page, 'light')
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.waitForSelector('.image-grid__head--dir')
    await page.waitForTimeout(500)
    await shot(page, 'organize-light-review')
    const folder = (await page.locator('.image-grid__head--dir .image-grid__title').first().textContent())!.trim()
    const n = await page.locator('.image-grid__group').first().locator('.tile').count()
    await page.click('.image-grid__accept >> nth=0')
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.image-grid__head--dir .image-grid__title')].every((e) => e.textContent?.trim() !== name),
      folder,
      { timeout: 60_000 }
    )
    expect(existsSync(join(dirs.library, folder))).toBe(true)
    expect(readdirSync(join(dirs.library, folder))).toHaveLength(n)
    // 原图还在源目录
    expect(readdirSync(source)).toHaveLength(3)
    expect(errors).toEqual([])
    await app.close()
  }, 600_000)
})
