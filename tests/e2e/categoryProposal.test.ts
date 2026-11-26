import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import { afterEach, expect, it } from 'vitest'
import { closeLeftoverApps, freshCase, SHOT_DIR } from './support/app'
import { bailianRequests, launchWithMockBailian } from './support/mockBailian'

afterEach(closeLeftoverApps)

it('从聊天确认类目录创建与嵌套迁移，重新打开会话仍显示处理结果', async () => {
  const dirs = freshCase('assistant-category-actions')
  mkdirSync(join(dirs.library,'A','B','子树'), { recursive:true })
  mkdirSync(join(dirs.library,'C','D'), { recursive:true })
  writeFileSync(join(dirs.library,'A','B','子树','标记.txt'),'测试文件')
  const { app, page } = await launchWithMockBailian(dirs)
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  const ask = async (text: string) => {
    const before = await page.locator('.category-proposal').count()
    await page.locator('.assistant__input').fill(text)
    await page.getByRole('button', { name:'发送' }).click()
    const card = page.locator('.category-proposal').nth(before)
    await card.getByRole('button',{ name:'确认' }).waitFor()
    return card
  }
  const create = await ask('创建类目录「山川/远景」')
  const composerStyle = () => page.locator('.assistant__composer').evaluate(el => getComputedStyle(el, '::before').backgroundColor)
  const firstColor = await composerStyle()
  await page.evaluate(() => window.api.settings.update({ accent: '#3F8F7B', appearance: 'dark' }))
  const reopen = async () => {
    await page.reload()
    await page.locator('.side-nav__label:text-is("诺诺助手")').click()
    await page.getByRole('button', {name:'对话记录'}).click()
    await page.locator('.assistant__hist-row').first().click()
  }
  await reopen()
  await expect.poll(composerStyle).not.toBe(firstColor)
  const darkColor = await composerStyle()
  await page.evaluate(() => window.api.settings.update({ accent: '#4A86C2' }))
  await reopen()
  await expect.poll(composerStyle).not.toBe(darkColor)
  await page.locator('.assistant__input').fill('测试')
  const sendStyle = await page.getByRole('button', {name:'发送'}).evaluate(el => {
    const style = getComputedStyle(el)
    return [style.backgroundImage, style.backgroundColor, style.backdropFilter]
  })
  expect(sendStyle).toEqual(['none', 'rgba(0, 0, 0, 0)', expect.stringContaining('blur(')])
  await page.locator('.assistant__input').fill('')
  expect(existsSync(join(dirs.library,'山川'))).toBe(false)
  await create.getByRole('button',{name:'确认'}).click()
  await create.getByRole('img', {name: '已完成'}).waitFor()
  expect(existsSync(join(dirs.library,'山川','远景'))).toBe(true)
  const cancelled = await ask('创建类目录「取消测试」')
  await cancelled.getByRole('button',{name:'取消'}).click()
  await cancelled.getByText('已取消').waitFor()
  expect(existsSync(join(dirs.library,'取消测试'))).toBe(false)
  const targetParent = page.locator('.side-nav__item').filter({has: page.locator('.side-nav__label:text-is("C")')})
  await targetParent.getByLabel('展开').click()
  await page.locator('.side-nav__label:text-is("D")').waitFor()
  const move = await ask('把类目录A下的子类目录B迁移到类目录C的子类目录D')
  expect(await move.textContent()).toContain('A\\B → C\\D\\B')
  await move.getByRole('button',{name:'确认'}).click()
  await move.getByRole('img', {name: '已完成'}).waitFor()
  const d = page.locator('.side-nav__item').filter({has: page.locator('.side-nav__label:text-is("D")')})
  await d.getByLabel('展开').click()
  await page.locator('.side-nav__label:text-is("B")').waitFor()
  expect(readFileSync(join(dirs.library,'C','D','B','子树','标记.txt'),'utf8')).toBe('测试文件')
  expect(existsSync(join(dirs.library,'A','B'))).toBe(false)
  expect(await bailianRequests(app)).toEqual([])
  await app.close()
  const next = await launchWithMockBailian(dirs)
  await next.page.locator('.side-nav__label:text-is("诺诺助手")').click()
  await next.page.getByRole('button',{name:'对话记录'}).click()
  await next.page.locator('.assistant__hist-row').first().click()
  await next.page.locator('.category-proposal').nth(2).getByRole('img', {name: '已完成'}).waitFor()
  expect(await next.page.locator('.category-proposal').getByRole('button',{name:'确认'}).count()).toBe(0)
}, 120_000)

it('复制卡片按待归档图片显示缩略图、余数和完成标记', async () => {
  const dirs = freshCase('category-filing-previews')
  const destination = join(dirs.library, '主题', '风景')
  mkdirSync(destination, { recursive: true })
  mkdirSync(join(dirs.library, '原图'))
  mkdirSync(join(dirs.data, 'thumbs'), { recursive: true })
  const info = statSync(destination, { bigint: true })
  const identity = [info.dev, info.ino, info.birthtimeNs].join(':')
  const { pg } = await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
  try {
    await pg.query("insert into library_root(kind,name,path,last_scan_at) values('CATEGORY','图库',$1,now())", [dirs.library])
    await pg.exec("insert into tag(name,category_id) values('风景',4); insert into ai_conversation(title) values('归档预览')")
    for (let i = 1; i <= 8; i++) {
      const pic = sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl('+i*39+',50%,78%)"/><circle cx="45" cy="18" r="8" fill="#ffedc4"/><path d="M0 60L22 26L42 48L52 33L64 50V64H0" fill="hsl('+i*39+',40%,42%)"/></svg>'))
      const bytes = await pic.clone().png().toBuffer()
      const hash = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(join(dirs.library, '原图', i+'.png'), bytes)
      await pic.webp().toFile(join(dirs.data, 'thumbs', hash+'.webp'))
      await pg.query("insert into image(content_hash,format,byte_size,thumb_ready) values($1,'PNG',$2,1)",[hash,bytes.length])
      await pg.query("insert into image_file(image_id,root_id,rel_path,mtime) values($1,1,$2,now())",[i,'原图\\'+i+'.png'])
      await pg.query("insert into image_tag(image_id,tag_id,source,status) values($1,1,'MANUAL','ACCEPTED')",[i])
    }
    for (const count of [1,6,8]) {
      const path = '主题\\风景'
      const payload = { scope:null, analysisCount:0, entries:[{kind:'copy',path,count}],
        filing:[{path,identity,imageIds:Array.from({length:count},(_,i)=>i+1)}] }
      const plan = await pg.query<{id:number}>('insert into category_proposal(home,payload) values($1,$2::jsonb) returning id',[dirs.library,JSON.stringify(payload)])
      await pg.query("insert into ai_message(conversation_id,role,content) values(1,'ASSISTANT',$1::jsonb)",[JSON.stringify({text:'',categoryProposalId:plan.rows[0].id})])
    }
  } finally { await closeDatabase() }
  const { app, page } = await launchWithMockBailian(dirs)
  const capture = async (name: string) => {
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const frame = await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true, stayAwake: true })
      return frame.toPNG()
    })
    mkdirSync(join(SHOT_DIR, 'app'), { recursive: true })
    writeFileSync(join(SHOT_DIR, 'app', name + '.png'), png)
  }
  const open = async () => {
    await page.locator('.side-nav__label:text-is("诺诺助手")').click()
    await page.getByRole('button',{name:'对话记录'}).click()
    await page.locator('.assistant__hist-row').first().click()
    await page.locator('.assistant__hist').waitFor({state:'detached'})
  }
  await open()
  const cards = page.locator('.category-proposal')
  for (const [index, count] of [1,6,8].entries()) {
    const card = cards.nth(index)
    const previews = card.getByRole('img',{name:count+' 张待复制图片'})
    await expect.poll(() => previews.locator('img').evaluateAll(imgs => imgs.filter(el=>(el as HTMLImageElement).naturalWidth > 0).length)).toBe(Math.min(6,count))
    expect(await card.locator('li small').count()).toBe(0)
    expect(await card.locator('.category-proposal__more').allTextContents()).toEqual(count>6?['+2']:[])
  }
  await capture('assistant-filing-previews-light')
  await page.evaluate(()=>window.api.settings.update({appearance:'dark',accent:'#3F8F7B'}))
  await page.reload()
  await open()
  const eight = cards.nth(2)
  await eight.getByText('+2',{exact:true}).waitFor()
  await eight.scrollIntoViewIfNeeded()
  await capture('assistant-filing-previews-dark')
  const right = async (selector: string) => eight.locator(selector).evaluate(el=>el.getBoundingClientRect().right)
  const edge = await right('.category-proposal__previews')
  expect(Math.abs(edge - await right('.category-proposal__actions button:last-child'))).toBeLessThan(2)
  await eight.getByRole('button',{name:'确认'}).click()
  await eight.getByRole('img',{name:'已完成'}).waitFor()
  expect(Math.abs(edge - await right('.category-proposal__done'))).toBeLessThan(2)
  expect(await eight.locator('.category-proposal__previews, button').count()).toBe(0)
  expect(existsSync(join(destination,'8.png'))).toBe(true)
  await cards.first().getByRole('button',{name:'取消'}).click()
  await cards.first().getByText('已取消',{exact:true}).waitFor()
  expect(await cards.first().locator('.category-proposal__thumb').count()).toBe(0)
}, 120_000)
