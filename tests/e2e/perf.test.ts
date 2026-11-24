import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 隐藏的 Electron 窗口限制动画回调频率，滚动帧率必须在可见窗口测量。
const COUNT = Number(process.env.LTM_PERF_COUNT ?? 3000)
const run = process.env.LTM_PERF === '1' && process.env.LTM_E2E_HIDDEN !== '1' ? it : it.skip

// 生成一张各不相同的小图：底色和一小块像素按序号变，保证内容哈希都不同；宽高比也轮着变
async function makeImage(file: string, i: number): Promise<void> {
  const w = [320, 240, 400, 180][i % 4]
  const h = [240, 320, 200, 360][i % 4]
  const raw = Buffer.alloc(w * h * 3, (i * 37) % 256)
  for (let k = 0; k < 64; k++) {
    raw[k] = (i >> (k % 16)) & 255
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 80 })
    .toFile(file)
}

describe('性能', () => {
  run(
    `${COUNT} 张图：扫描、列表、首屏、滚动、内存`,
    async () => {
      const dirs = freshCase('perf')
      const source = join(dirs.root, 'pics')
      mkdirSync(source, { recursive: true })
      mkdirSync(dirs.library, { recursive: true })
      for (let i = 0; i < COUNT; i++) {
        await makeImage(join(source, `p${String(i).padStart(5, '0')}.jpg`), i)
      }

      const { app, page } = await launchApp(dirs)
      const cdp = await page.context().newCDPSession(page)
      const memory = async () => ({
        processes: await app.evaluate(({ app: a }) => a.getAppMetrics().map(m => ({
          pid: m.pid, name: m.name ?? m.type, workingSetMiB: Math.round(m.memory.workingSetSize / 1024),
          privateMiB: m.memory.privateBytes === undefined ? null : Math.round(m.memory.privateBytes / 1024)
        }))),
        heapMiB: Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1024 ** 2),
        dom: await cdp.send('Memory.getDOMCounters')
      })
      const startup = await memory()
      const t0 = Date.now()
      await importFolder(app, page, source)
      await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 30 * 60_000 })
      const scanMs = Date.now() - t0

      // 进源目录：主进程查全量列表 + 首屏渲染
      const t1 = Date.now()
      await page.click('.side-nav__label:text-is("pics")')
      await page.waitForFunction((n) => {
        const total = [...document.querySelectorAll('.image-grid__count')].reduce((sum, e) => sum + parseInt(e.textContent ?? '0'), 0)
        return total === n && document.querySelectorAll('.tile').length > 0
      }, COUNT, { timeout: 60_000 })
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.tile__pic')].slice(0, 12).every((i) => i.complete))
      const firstScreenMs = Date.now() - t1

      const listing = await page.evaluate(async () => {
        const overview = await window.api.library.getOverview()
        if (!overview.ok || !overview.data.sources[0]) throw new Error('未找到测试源目录')
        const t = performance.now()
        const result = await window.api.gallery.list({ view: 'source', sourceId: overview.data.sources[0].id, sub: '', sort: 'new' })
        if (!result.ok || result.data.items.length === 0) throw new Error('未读取到测试图片')
        return { ms: performance.now() - t, count: result.data.items.length, first: result.data.items[0].imageId, last: result.data.items.at(-1)!.imageId }
      })
      const listMs = listing.ms
      expect(listing.count).toBe(COUNT)
      await page.locator(`.tile[data-id="${listing.first}"]`).click()
      await page.keyboard.press('End')
      await page.locator(`.tile--on[data-id="${listing.last}"]`).waitFor()
      await page.keyboard.press('Home')
      await page.locator(`.tile--on[data-id="${listing.first}"]`).waitFor()
      if (COUNT > 200) expect(await page.locator('.tile').count()).toBeLessThan(COUNT)

      // 从头滚到尾：数一下这段时间的帧数
      const scroll = await page.evaluate(async () => {
        const el = document.querySelector<HTMLElement>('.image-grid')!
        let frames = 0
        let longest = 0
        let last = performance.now()
        let on = true
        const tick = (): void => {
          const now = performance.now()
          longest = Math.max(longest, now - last)
          last = now
          frames++
          if (on) {
            requestAnimationFrame(tick)
          }
        }
        requestAnimationFrame(tick)
        const start = performance.now()
        const step = el.clientHeight * 0.8
        while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
          el.scrollTop += step
          await new Promise((r) => setTimeout(r, 16))
        }
        const ms = performance.now() - start
        on = false
        return { ms, fps: (frames * 1000) / ms, longestFrameMs: longest, height: el.scrollHeight }
      })

      const afterScroll = await memory()
      await page.keyboard.press('Home')
      const firstTile = page.locator(`.tile[data-id="${listing.first}"]`)
      const cycle = async () => {
        await firstTile.dblclick()
        await page.locator('.viewer__pic').waitFor()
        await page.keyboard.press('Escape')
        await page.locator('.viewer').waitFor({ state: 'detached' })
        await page.locator('.title-bar__gear').click()
        await page.getByRole('tab', { name: '外观', exact: true }).click()
        await page.keyboard.press('Escape')
        await page.locator('.set-dlg').waitFor({ state: 'detached' })
      }
      const retained = async () => {
        await cdp.send('HeapProfiler.collectGarbage')
        return memory()
      }
      await cycle()
      const warm = await retained()
      for (let i = 0; i < 20; i++) await cycle()
      const afterCycles = await retained()

      const result = { count: COUNT, scanMs, perImageMs: Math.round(scanMs / COUNT), firstScreenMs, listMs: Math.round(listMs), scroll, memory: { startup, afterScroll, warm, afterCycles } }
      mkdirSync(resolve('test-output'), { recursive: true })
      writeFileSync(resolve('test-output/perf.json'), JSON.stringify(result, null, 2))
      console.log(JSON.stringify(result))
      // 粗的底线：列表查询 1 秒内、首屏 5 秒内、滚动不低于 30 帧
      expect(listMs).toBeLessThan(1000)
      expect(firstScreenMs).toBeLessThan(5000)
      await app.close()
      await expect.poll(() => afterCycles.processes.filter(({ pid }) => {
        try { process.kill(pid, 0); return true } catch { return false }
      }), { timeout: 10_000 }).toEqual([])
      expect(scroll.fps).toBeGreaterThan(30)
    },
    60 * 60_000
  )

  run('分级结束后空闲会释放模型工作进程', async () => {
    const dirs = freshCase('perf-idle-rating')
    const source = join(dirs.root, 'pics')
    mkdirSync(source)
    await makeImage(join(source, '测试图.jpg'), 1)
    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, source)
    const metrics = () => app.evaluate(({ app: a }) => a.getAppMetrics().map(m => ({
      name: m.name ?? m.type, workingSetMiB: Math.round(m.memory.workingSetSize / 1024), cpuPercent: m.cpu.percentCPUUsage
    })))
    const hasModel = (rows: Awaited<ReturnType<typeof metrics>>) => rows.some(m => m.name === '诺诺本地分级')
    await expect.poll(async () => hasModel(await metrics()), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => hasModel(await metrics()), { timeout: 160_000, interval: 2000 }).toBe(false)
    const idle = await metrics()
    mkdirSync(resolve('test-output'), { recursive: true })
    writeFileSync(resolve('test-output/perf-idle.json'), JSON.stringify(idle, null, 2))
    await app.close()
  }, 210_000)
})
