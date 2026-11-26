import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

const N = 80

// 底栏“本地分级中”胶囊上的“已判/总数”
async function pillNumbers(page: Page): Promise<[number, number]> {
  const text = (await page.locator('.rating-pill__num').textContent()) ?? ''
  const [a, b] = text.split('/').map((s) => Number(s.trim()))
  return [a, b]
}

describe('退出再进来，进度接着上次', () => {
  it('主进程在目录扫描中异常退出后，恢复进度并完成剩余图片', async () => {
    const dirs = freshCase('resume-scan-crash')
    const source = join(dirs.root, 'pics')
    const count = 144
    mkdirSync(source, { recursive: true })
    for (let i = 0; i < count; i++) {
      await sharp({ create: { width: 720, height: 540, channels: 3, background: { r: i, g: 180, b: 205 } } })
        .png().toFile(join(source, `image-${i}.png`))
    }

    const first = await launchApp(dirs)
    await importFolder(first.app, first.page, source)
    await expect.poll(async () => {
      const state = await first.page.evaluate(() => window.api.scan.getState())
      return state.ok ? state.data.progress?.done ?? 0 : 0
    }, { timeout: 15_000, interval: 50 }).toBeGreaterThanOrEqual(40)
    const exitCode = new Promise<number | null>((done) => first.app.process().once('exit', done))
    void first.app.evaluate(() => process.exit(86)).catch(() => undefined)
    expect(await exitCode).toBe(86)

    const second = await launchApp(dirs)
    const recoveredProgress = () => /恢复扫描断点 (\d+)\/(\d+)/.exec(readFileSync(join(dirs.data, 'logs', 'main.log'), 'utf8'))
    await expect.poll(recoveredProgress, { timeout: 10_000 }).not.toBeNull()
    const recovered = recoveredProgress()
    expect(Number(recovered?.[2])).toBe(count)
    expect(Number(recovered?.[1])).toBeGreaterThanOrEqual(32)
    expect(Number(recovered?.[1])).toBeLessThan(count)
    await second.page.locator('.side-nav__label:text-is("pics")').click()
    await second.page.waitForFunction((n) => {
      const item = [...document.querySelectorAll('.side-nav__item')].find((el) => el.querySelector('.side-nav__label')?.textContent === 'pics')
      return item?.querySelector('.side-nav__count')?.textContent === String(n) && document.querySelectorAll('.tile').length > 0
    }, count)
    await expect.poll(() => second.page.evaluate(() => window.api.scan.getState())).toMatchObject({
      ok: true, data: { progress: null, last: { total: count, failed: 0, stopped: false } }
    })
    await second.app.close()
  })

  it('分级中一键整理只弹提示；本地分级判到一半退出：再打开从“已判/总数”接着走，不从 0 开始，判过的不重判', async () => {
    const dirs = freshCase('resume')
    const src = join(dirs.root, 'pics')
    mkdirSync(src, { recursive: true })
    for (let i = 0; i < N; i++) {
      await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: (i * 37) % 255, g: (i * 71) % 255, b: (i * 13) % 255 } } })
        .jpeg()
        .toFile(join(src, `p${String(i).padStart(3, '0')}.jpg`))
    }

    // 第一次：判到二十几张就正常关掉
    let run = await launchApp(dirs)
    await importFolder(run.app, run.page, src)
    await run.page.waitForSelector('.rating-pill', { timeout: 120_000 })
    // 分级中：一键整理是灰的，点了只弹提示条，不开确认框
    await run.page.waitForSelector('.organize--waiting')
    // 按钮带 aria-disabled，Playwright 默认不点，真实用户点得到
    await run.page.click('.organize', { force: true })
    await run.page.waitForSelector('.app-toast:has-text("本地分级判完才能整理")')
    expect(await run.page.locator('.org-dlg').count()).toBe(0)
    await run.page.waitForFunction(() => Number(document.querySelector('.rating-pill__num')?.textContent?.split('/')[0] ?? 0) >= 22, null, { timeout: 120_000 })
    const [before, total] = await pillNumbers(run.page)
    expect(total).toBe(N)
    await run.app.close()

    // 第二次：胶囊一出来就是上次的数（至少是最后存下的那一小批），总数不变
    run = await launchApp(dirs)
    await run.page.waitForSelector('.rating-pill', { timeout: 120_000 })
    const [again, total2] = await pillNumbers(run.page)
    expect(total2).toBe(N)
    expect(again).toBeGreaterThanOrEqual(20)
    expect(again).toBeLessThanOrEqual(N)
    expect(before - again).toBeLessThan(20)

    // 判完：最后是 N/N，每张只判了一次
    const last = await run.page.evaluate(
      () =>
        new Promise<{ running: boolean; done: number; total: number }>((done) => {
          window.api.rating.onProgress((p) => {
            if (!p.running) {
              done(p)
            }
          })
        })
    )
    expect(last).toEqual({ running: false, done: N, total: N })
    await run.app.close()
  }, 400_000)
})
