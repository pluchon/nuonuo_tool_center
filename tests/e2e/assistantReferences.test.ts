import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import { closeLeftoverApps, freshCase, launchApp } from './support/app'

afterEach(closeLeftoverApps)

it('图库多选、重复追加、撤回和拖动结果卡片形成可独立删除的引用', async () => {
  const dirs = freshCase('assistant-img-references')
  const folder = join(dirs.library, '测试图库')
  mkdirSync(folder, { recursive: true })
  mkdirSync(dirs.data, { recursive: true })
  mkdirSync(join(dirs.data, 'thumbs'), { recursive: true })
  const { pg } = await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
  try {
    await pg.query("insert into library_root (kind, name, path, last_scan_at) values ('CATEGORY','类目录',$1,now())", [dirs.library])
    await pg.exec("insert into tag (category_id,name) values (4,'星空')")
    for (const [i, color] of ['#3778ce', '#5572be', '#985e7a'].entries()) {
      const name = '星图' + (i + 1) + '.png'
      const pic = sharp({ create: { width: 96, height: 96, channels: 3, background: color } })
      const hash = createHash('sha256').update(await pic.clone().png().toBuffer()).digest('hex')
      await pic.clone().png().toFile(join(folder, name))
      await pic.webp().toFile(join(dirs.data, 'thumbs', hash + '.webp'))
      await pg.query("insert into image (content_hash,thumb_ready,format,byte_size,display_name,is_r18,rating_source) values ($1,1,'PNG',100,$2,$3,'MANUAL')", [hash, name, i === 2])
      await pg.query("insert into image_file (image_id,root_id,rel_path,mtime) values ($1,1,$2,now())", [i + 1, '测试图库/' + name])
      await pg.query("insert into image_tag (image_id,tag_id,status,source) values ($1,1,'ACCEPTED','MANUAL')", [i + 1])
    }
  } finally { await closeDatabase() }
  const { app, page } = await launchApp(dirs)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }) })
  await app.evaluate(() => {
    const fixture = globalThis as typeof globalThis & { referenceRequests: number }
    fixture.referenceRequests = 0
    globalThis.fetch = async () => {
      fixture.referenceRequests++
      throw new Error('本地引用测试不允许网络请求')
    }
  })
  const field = page.locator('.assistant__input')
  const openGallery = async () => {
    await page.locator('.side-nav__label:text-is("全部图片")').click()
    await page.locator('.tile').first().click()
    await page.locator('.tile').nth(1).click({ modifiers: ['Control'] })
    await page.getByRole('button', { name: '问诺诺', exact: true }).click()
  }
  await openGallery()
  const chips = page.locator('.assistant__composer .image-references__item')
  await chips.first().waitFor()
  expect(await chips.count()).toBe(2)
  await expect.poll(() => chips.locator('img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length)).toBe(2)
  expect(await chips.first().evaluate((el) => el.parentElement!.textContent)).not.toContain('图库选图')
  expect(await field.inputValue()).toBe('')
  await expect.poll(() => field.evaluate((el) => document.activeElement === el)).toBe(true)
  await field.fill('比较这些图片的共同标签')
  await openGallery()
  expect(await chips.count()).toBe(2)
  expect(await field.inputValue()).toBe('比较这些图片的共同标签')
  await field.press('Enter')
  await page.getByText('共同标签：星空。', { exact: true }).waitFor()
  const user = page.locator('.assistant__user').last()
  const thumb = user.locator('.image-references__item').nth(1)
  await thumb.dblclick()
  const viewer = page.getByRole('dialog', { name: '查看大图' })
  await expect.poll(() => viewer.locator('.viewer__pic').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(96)
  expect(await viewer.locator('.viewer__pic').getAttribute('src')).toMatch(/^ltm:\/\/file\//)
  await page.keyboard.press('Escape')
  await user.hover()
  await user.getByRole('button', { name: '回撤到输入框' }).click()
  await chips.first().waitFor()
  expect(await chips.count()).toBe(2)
  await chips.nth(1).getByRole('button', {name: /移除引用/}).click()
  expect(await chips.count()).toBe(1)
  await chips.first().getByRole('button', {name: /移除引用/}).click()
  await page.getByRole('switch', { name: '包含 R-18' }).click()
  await field.fill('找标签为星空的图')
  await field.press('Enter')
  const cards = page.locator('.assistant__reply .assistant__pic')
  await cards.nth(1).waitFor()
  await cards.nth(1).dblclick()
  await page.locator('.viewer__pic').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.viewer__pic').waitFor({ state: 'detached' })
  expect(await chips.count()).toBe(0)
  const drag = async (card = cards.nth(1)) => {
    const bounds = (await card.boundingBox())!
    const dest = (await field.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await expect.poll(() => card.evaluate((el) => el.matches(':active'))).toBe(true)
    await page.mouse.move(dest.x + 12, dest.y + 8, { steps: 14 })
    await page.mouse.move(dest.x + 14, dest.y + 10)
    await page.mouse.up()
  }
  await drag()
  await chips.first().waitFor()
  expect(await page.locator('.assistant__prediction').count()).toBe(0)
  expect(await chips.first().getAttribute('data-position')).toBe('2')
  const expected = await chips.first().locator('img').getAttribute('alt')
  expect(expected).toBeTruthy()
  await drag()
  expect(await chips.count()).toBe(1)
  const protectedCard = cards.filter({ has: page.locator('.assistant__pic-r18') })
  expect(await protectedCard.getAttribute('draggable')).toBe('true')
  await drag(protectedCard)
  await chips.nth(1).waitFor()
  expect(await protectedCard.getAttribute('draggable')).toBe('true')
  await field.fill('第二张图叫什么？')
  await field.press('Enter')
  const last = page.locator('.assistant__reply').nth(1)
  await last.waitFor()
  expect(await last.innerText()).toContain(expected)
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { referenceRequests: number }).referenceRequests)).toBe(0)
}, 120_000)
