import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, launchApp, setAppearance, shot, type CaseDirs } from './support/app'
import { importFolder } from './support/picker'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 晴天草地和星空夜景两种画面（不用任何真实图片）
const SUNNY = '<rect width="100%" height="100%" fill="#87CEEB"/><circle cx="700" cy="140" r="80" fill="#FFD23F"/><rect y="420" width="900" height="180" fill="#4CAF50"/>'
const NIGHT = '<rect width="100%" height="100%" fill="#0B1340"/><circle cx="700" cy="140" r="60" fill="#F5F3CE"/><circle cx="120" cy="80" r="3" fill="#fff"/><circle cx="300" cy="120" r="2" fill="#fff"/><rect y="460" width="900" height="140" fill="#1B1B2F"/>'
async function makeImage(file: string, body: string): Promise<void> {
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">${body}</svg>`)).jpeg({ quality: 88 }).toFile(file)
}

// 等日志里出现某一行
async function waitForLog(dirs: CaseDirs, text: string, timeout = 240_000): Promise<void> {
  const file = join(dirs.data, 'logs', 'main.log')
  const start = Date.now()
  while (!(existsSync(file) && readFileSync(file, 'utf8').includes(text))) {
    if (Date.now() - start > timeout) {
      throw new Error(`等不到日志：${text}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe('语义向量和按图找相似', () => {
  it('新图补好向量后，上传一张晴天的图能找到晴天那张；“+”菜单和附件预览', async () => {
    const dirs = freshCase('semantic')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await makeImage(join(source, 'sunny.jpg'), SUNNY)
    await makeImage(join(source, 'night.jpg'), NIGHT)
    const upload = join(dirs.root, 'query-sunny.jpg')
    await makeImage(upload, SUNNY.replace('#4CAF50', '#5DBB63'))

    const { app, page } = await launchApp(dirs)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await importFolder(app, page, source)
    await waitForLog(dirs, '补了 2 张图的语义向量')

    await page.locator('.side-nav__label:text-is("诺诺助手")').click()
    await page.waitForSelector('.assistant__welcome')
    await page.click('.assistant__plus')
    await page.waitForSelector('.assistant__plus-menu')
    await page.waitForTimeout(300)
    await shot(page, 'semantic-light-plus-menu')
    await page.keyboard.press('Escape')
    await page.locator('.assistant__file').setInputFiles(upload)
    await page.waitForSelector('.assistant__attach')
    await page.click('.assistant__send')
    await page.waitForSelector('.assistant__reply', { timeout: 120_000 })
    await page.waitForSelector('.assistant__sent-img')
    const names = await page.locator('.assistant__reply').last().locator('.assistant__pic-name').allTextContents()
    // 夜景那张构图相近但内容不同（相似度约 0.54），不该出现
    expect(names).toEqual(['sunny.jpg'])
    await expect(page.locator('.assistant__how').last().textContent()).resolves.toContain('按你传的图找了相似的')
    await page.waitForTimeout(400)
    await shot(page, 'semantic-light-similar')
    await setAppearance(page, 'dark')
    await page.locator('.side-nav__label:text-is("诺诺助手")').click()
    // 换外观会重新加载页面：从对话记录里打开刚才那段
    await page.click('.assistant__round[aria-label="对话记录"]')
    await page.click('.assistant__hist-row >> nth=0')
    await page.waitForSelector('.assistant__sent-img')
    await page.waitForTimeout(400)
    await shot(page, 'semantic-dark-similar')
    expect(errors).toEqual([])
    await app.close()
  }, 400_000)
})
