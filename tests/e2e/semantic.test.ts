import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, setAppearance, shot } from './support/app'
import { importFolder } from './support/picker'
import { bailianRequests, launchWithMockBailian } from './support/mockBailian'
import { bmp24 } from '../support/bmp'

sharp.cache(false)

afterEach(async () => {
  await closeLeftoverApps()
})

// 使用合成草地图和蓝色位图，避免接触正式图库。
const SUNNY = '<rect width="100%" height="100%" fill="#87CEEB"/><circle cx="700" cy="140" r="80" fill="#FFD23F"/><rect y="420" width="900" height="180" fill="#4CAF50"/>'
async function makeImage(file: string, body: string): Promise<void> {
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">${body}</svg>`)).jpeg({ quality: 88 }).toFile(file)
}

describe('语义向量和按图找相似', () => {
  it('新图补好向量后，上传一张晴天的图能找到晴天那张；“+”菜单和附件预览', async () => {
    const dirs = freshCase('semantic')
    const source = join(dirs.root, 'pics')
    mkdirSync(source, { recursive: true })
    await makeImage(join(source, 'sunny.jpg'), SUNNY)
    writeFileSync(join(source, 'blue.bmp'), bmp24(80, 60))
    const upload = join(dirs.root, 'query-sunny.jpg')
    await makeImage(upload, SUNNY.replace('#4CAF50', '#5DBB63'))

    const { app, page } = await launchWithMockBailian(dirs)
    expect((await page.evaluate(() => window.api.ai.embeddingLimit(2))).ok).toBe(true)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await importFolder(app, page, source)
    await page.locator('.side-nav__label:text-is("AI 建议")').click()
    await page.locator('.tile').nth(1).waitFor({ timeout: 60_000 })
    const reviewed = await page.evaluate(async () => {
      const list = await window.api.gallery.list({ view: 'ai', sort: 'new' })
      if (!list.ok) throw new Error(list.message)
      return window.api.suggestion.decideMany(list.data.items.map((item) => item.imageId), false)
    })
    expect(reviewed).toMatchObject({ ok: true, data: { done: 2, failed: 0 } })
    // 助手只在类目录检索；保留源图，验证归档副本继承同一张图片的标签。
    const category = join(dirs.library, '测试归档')
    mkdirSync(category, { recursive: true })
    for (const filename of ['sunny.jpg', 'blue.bmp']) {
      copyFileSync(join(source, filename), join(category, filename))
    }
    const scan = await page.evaluate(() => window.api.scan.start(null))
    expect(scan.ok).toBe(true)
    await expect.poll(() => page.evaluate(() => window.api.scan.getState()), { timeout: 60_000 }).toMatchObject({
      ok: true, data: { progress: null, last: { stopped: false, rootName: null } }
    })
    await page.locator('.side-nav__label:text-is("pics")').click()
    const tiles = page.locator('.tile')
    await tiles.nth(1).waitFor()
    for (const tile of await tiles.all()) {
      await tile.click()
      await page.locator('.tag-editor__input').fill('场景')
      await page.locator('.tag-editor__input').press('Enter')
      await page.locator('.tag-editor__tag').filter({ hasText: '场景' }).waitFor()
    }
    await expect.poll(async () => (await bailianRequests(app)).filter((route) => route === 'multimodal-embedding').length, { timeout: 90_000 }).toBe(2)

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
    await page.locator('.assistant__user .attachment-card__preview').waitFor()
    expect(await page.locator('.assistant__user .attachment-card__name').textContent()).toBe('query-sunny.jpg')
    expect(await page.locator('.assistant__user .attachment-card__type').textContent()).toBe('JPEG')
    const names = await page.locator('.assistant__reply').last().locator('.assistant__pic-name').allTextContents()
    // 模拟向量按绿色通道区分样本，检索应只返回草地图。
    expect(names).toEqual(['sunny.jpg'])
    await expect(page.locator('.assistant__how').last().textContent()).resolves.toContain('按你传的图找了相似的')
    await page.waitForTimeout(400)
    await shot(page, 'semantic-light-similar')
    await setAppearance(page, 'dark')
    await page.locator('.side-nav__label:text-is("诺诺助手")').click()
    // 换外观会重新加载页面：从对话记录里打开刚才那段
    await page.click('.assistant__round[aria-label="对话记录"]')
    await page.click('.assistant__hist-row >> nth=0')
    await page.locator('.assistant__user .attachment-card__preview').waitFor()
    expect(await page.locator('.assistant__user .attachment-card__name').textContent()).toBe('query-sunny.jpg')
    await page.waitForTimeout(400)
    await shot(page, 'semantic-dark-similar')
    expect((await bailianRequests(app)).filter((route) => route === 'multimodal-embedding')).toHaveLength(3)
    // 改名后上传同一份 BMP，应复用已归档的向量。上一张查询图的结果不能混入。
    await page.locator('.assistant__file').setInputFiles({
      name: '改过名字.bmp', mimeType: 'image/bmp', buffer: readFileSync(join(source, 'blue.bmp'))
    })
    await page.waitForSelector('.assistant__attach')
    await page.click('.assistant__send')
    await expect.poll(() => page.locator('.assistant__reply').last().locator('.assistant__pic-name').allTextContents(),
      { timeout: 30_000 }).toEqual(['blue.bmp'])
    await shot(page, 'semantic-bmp-reuse-dark')
    expect((await bailianRequests(app)).filter((route) => route === 'multimodal-embedding')).toHaveLength(3)
    expect(errors).toEqual([])
    await app.close()
  }, 400_000)
})
