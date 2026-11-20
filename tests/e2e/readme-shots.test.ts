import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { afterEach, describe, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance } from './support/app'
import { importFolder } from './support/picker'

// README 里的界面截图：用画出来的风景图建一个示例图库，浅色、深色各截一张，存到 test-output/readme-shots/，再手动传 OSS。只在 LTM_SHOTS=1 时跑
sharp.cache(false)
const run = process.env.LTM_SHOTS === '1' ? it : it.skip
const OUT = resolve('test-output/readme-shots')

afterEach(async () => {
  await closeLeftoverApps()
})

// 一张风景：天空渐变、太阳、远近两层山，可选一片海
function landscape(w: number, h: number, sky: [string, string], sun: string, hills: [string, string], sea?: string): string {
  const hz = h * 0.62
  const far = `M0 ${hz} Q ${w * 0.25} ${hz - h * 0.22} ${w * 0.5} ${hz - h * 0.05} T ${w} ${hz - h * 0.12} V ${h} H 0 Z`
  const near = `M0 ${h * 0.8} Q ${w * 0.35} ${h * 0.6} ${w * 0.7} ${h * 0.78} T ${w} ${h * 0.74} V ${h} H 0 Z`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#s)"/>
  <circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.09}" fill="${sun}" opacity="0.92"/>
  ${sea ? `<rect y="${hz}" width="${w}" height="${h - hz}" fill="${sea}"/>` : ''}
  <path d="${far}" fill="${hills[0]}"/>
  <path d="${near}" fill="${hills[1]}"/>
</svg>`
}

// 示例图：名字、大小、配色、标签
const SAMPLES: Array<{ name: string; w: number; h: number; svg: [[string, string], string, [string, string], string?]; tags: string[] }> = [
  { name: '晨光山谷', w: 1600, h: 1000, svg: [['#FBD3C4', '#FDEFD9'], '#FFF6E0', ['#C9B8E8', '#9E8BCB']], tags: ['风景', '清晨'] },
  { name: '海边黄昏', w: 1600, h: 900, svg: [['#F7B7A3', '#FDE2C8'], '#FFE7B0', ['#E3A6A1', '#B97A8C'], '#8FB6D9'], tags: ['风景', '海', '黄昏'] },
  { name: '薄荷高原', w: 1000, h: 1400, svg: [['#CDEFE4', '#F2FBF7'], '#FFFFFF', ['#9ED3C1', '#5FA894']], tags: ['风景', '绿'] },
  { name: '紫色远山', w: 1400, h: 1000, svg: [['#D9CCF2', '#F4EFFC'], '#FFFFFF', ['#B4A2DE', '#7D68B8']], tags: ['风景'] },
  { name: '夏日海湾', w: 1800, h: 1000, svg: [['#A9D6F5', '#E6F4FD'], '#FFF9D6', ['#9CCB9E', '#6FAE7E'], '#5E9FD0'], tags: ['风景', '海', '夏天'] },
  { name: '樱粉小丘', w: 1200, h: 1200, svg: [['#F9D4E0', '#FFF0F5'], '#FFFFFF', ['#F0B3C8', '#D98AA8']], tags: ['风景', '春天'] },
  { name: '琥珀麦田', w: 1500, h: 1000, svg: [['#F8DDA6', '#FFF4DC'], '#FFFFFF', ['#E8C27A', '#C99A4B']], tags: ['风景', '秋天'] },
  { name: '雾蓝峡谷', w: 1000, h: 1500, svg: [['#BCD2EA', '#EEF4FB'], '#FFFFFF', ['#93AED0', '#6683AD']], tags: ['风景', '雾'] },
  { name: '晚霞湖面', w: 2000, h: 900, svg: [['#E9A9C9', '#F9DCC4'], '#FFE9C2', ['#B98BC2', '#8D6AA8'], '#C9A3D4'], tags: ['风景', '黄昏'] },
  { name: '青竹坡地', w: 1300, h: 1000, svg: [['#DDF1D3', '#F6FCF2'], '#FFFFFF', ['#A8D49A', '#6FA960']], tags: ['风景', '绿'] },
  { name: '冬日雪原', w: 1600, h: 1100, svg: [['#DCE6F2', '#FFFFFF'], '#FFF6E5', ['#E8EEF6', '#C3D0E2']], tags: ['风景', '冬天'] },
  { name: '橘色日出', w: 1100, h: 1400, svg: [['#FFC9A8', '#FFF0DF'], '#FFF3C4', ['#F2A88C', '#D47B6A']], tags: ['风景', '清晨'] },
  { name: '星夜山脊', w: 1700, h: 1000, svg: [['#3E3A6B', '#7C6BA8'], '#FCEFC7', ['#5B4F8C', '#2F2A55']], tags: ['风景', '夜晚'] },
  { name: '晴空草甸', w: 1500, h: 900, svg: [['#B5DDF7', '#EAF6FE'], '#FFFBE0', ['#B9E0A5', '#86C076']], tags: ['风景', '夏天'] },
  { name: '玫瑰海岸', w: 1200, h: 1500, svg: [['#F6C4CF', '#FDEBEE'], '#FFFFFF', ['#E9A1B4', '#C77693'], '#E7B9C6'], tags: ['风景', '海'] },
  { name: '远方灯塔', w: 1800, h: 1100, svg: [['#C3DCEB', '#F1F7FB'], '#FFF6D8', ['#A7C6D9', '#7499B3'], '#88B1CC'], tags: ['风景', '海'] },
  { name: '淡紫花田', w: 1400, h: 1000, svg: [['#E6DCF7', '#FBF8FF'], '#FFFFFF', ['#CDB8EE', '#A98BD9']], tags: ['风景', '花'] },
  { name: '暖阳坡道', w: 1000, h: 1300, svg: [['#FCE3B8', '#FFF7E8'], '#FFFFFF', ['#F2C98E', '#D9A15E']], tags: ['风景', '秋天'] }
]

// 等页面上所有动画做完
function settle(page: Page): Promise<unknown> {
  return page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
}

describe('README 截图', () => {
  run('示例图库的浅色、深色界面', async () => {
    const dirs = freshCase('readme-shots')
    const src = join(dirs.root, '风景')
    mkdirSync(src, { recursive: true })
    mkdirSync(dirs.library, { recursive: true })
    mkdirSync(OUT, { recursive: true })
    for (const s of SAMPLES) {
      const [sky, sun, hills, sea] = s.svg
      await sharp(Buffer.from(landscape(s.w, s.h, sky, sun, hills, sea)))
        .jpeg({ quality: 90 })
        .toFile(join(src, `${s.name}.jpg`))
    }

    const { app, page } = await launchApp(dirs)
    await importFolder(app, page, src)
    await page.waitForSelector('.app-toast:has-text("扫描完成")', { timeout: 120_000 })

    // 按示例打标签（按名字找到图片 id）
    await page.evaluate(async (samples) => {
      const res = (await window.api.gallery.list({ view: 'untagged', sort: 'new' })) as unknown as { data: { items: Array<{ imageId: number; name: string }> } }
      const byName = new Map(res.data.items.map((i) => [i.name.replace(/\.jpg$/, ''), i.imageId]))
      const tags = [...new Set(samples.flatMap((s) => s.tags))]
      for (const t of tags) {
        const ids = samples.filter((s) => s.tags.includes(t)).map((s) => byName.get(s.name)).filter((x): x is number => x !== undefined)
        await window.api.edit.addTag({ imageIds: ids, name: t })
      }
    }, SAMPLES)

    for (const mode of ['light', 'dark'] as const) {
      await setAppearance(page, mode)
      await page.waitForFunction(() => document.querySelectorAll('.tile .tile__pic').length > 10)
      await page.locator('.tile').nth(4).click()
      await page.waitForSelector('.detail-panel__pic')
      await page.mouse.move(5, 400)
      await settle(page)
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img')].every((i) => i.complete))
      await page.screenshot({ path: join(OUT, `screenshot-${mode}.png`) })
    }
    await app.close()
  })
})
