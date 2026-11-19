import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'
import { pickFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 性能测试图片数（和用户的二次元目录同一量级）；只在 LTM_PERF=1 时跑，平时跳过
const COUNT = Number(process.env.LTM_PERF_COUNT ?? 3000)
const run = process.env.LTM_PERF === '1' ? it : it.skip

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
      await page.click('.gallery__pick')
      await pickFolder(page, source)
      const t0 = Date.now()
      await page.click('.folder-pick__confirm')
      await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 30 * 60_000 })
      const scanMs = Date.now() - t0

      // 进源目录：主进程查全量列表 + 首屏渲染
      const t1 = Date.now()
      await page.click('.side-nav__label:text-is("pics")')
      await page.waitForFunction((n) => document.querySelectorAll('.tile').length === n, COUNT, { timeout: 60_000 })
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.tile__pic')].slice(0, 12).every((i) => i.complete))
      const firstScreenMs = Date.now() - t1

      const listMs = await page.evaluate(async () => {
        const t = performance.now()
        await window.api.gallery.list({ view: 'source', sourceId: 1, sub: '', q: '', sort: 'new', onlyHere: false })
        return performance.now() - t
      })

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

      const memory = await app.evaluate(async ({ app: a }) =>
        (await a.getAppMetrics()).map((m) => ({ type: m.type, mb: Math.round(m.memory.workingSetSize / 1024) }))
      )

      const result = { count: COUNT, scanMs, perImageMs: Math.round(scanMs / COUNT), firstScreenMs, listMs: Math.round(listMs), scroll, memory }
      mkdirSync(resolve('test-output'), { recursive: true })
      writeFileSync(resolve('test-output/perf.json'), JSON.stringify(result, null, 2))
      console.log(JSON.stringify(result))
      // 粗的底线：列表查询 1 秒内、首屏 5 秒内、滚动不低于 30 帧
      expect(listMs).toBeLessThan(1000)
      expect(firstScreenMs).toBeLessThan(5000)
      expect(scroll.fps).toBeGreaterThan(30)
      await app.close()
    },
    60 * 60_000
  )
})
