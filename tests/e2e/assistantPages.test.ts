import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { closeDatabase, openDatabase } from '../../src/main/db/client'
import { closeLeftoverApps, freshCase } from './support/app'
import { launchWithMockBailian } from './support/mockBailian'

afterEach(closeLeftoverApps)

it('大量命中时仅渲染当前页，末页包含最后一张图片，重开会话回到首页', async () => {
  const dirs = freshCase('assistant-result-pages')
  const source = join(dirs.root, '未归档')
  mkdirSync(source, { recursive: true })
  mkdirSync(join(dirs.library, 'pics'), { recursive: true })
  mkdirSync(dirs.data, { recursive: true })
  const { pg } = await openDatabase(join(dirs.data, 'pgdata'), resolve('drizzle'))
  try {
    await pg.query("INSERT INTO library_root (kind, name, path, last_scan_at) VALUES ('CATEGORY', '类目录', $1, now())", [dirs.library])
    await pg.query("INSERT INTO library_root (kind, name, path, last_scan_at) VALUES ('SOURCE', '未归档', $1, now())", [source])
    await pg.exec(`
      INSERT INTO image (content_hash, format, byte_size, display_name, is_r18, rating_source)
        SELECT 'pages-' || n, 'JPG', 1, '图片-' || n, true, 'MANUAL' FROM generate_series(1, 2401) AS n;
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, 1, 'pics/' || content_hash || '.jpg', now() FROM image;
      INSERT INTO image (content_hash, format, byte_size, display_name, is_r18, rating_source)
        VALUES ('source-only', 'JPG', 1, '仅在源目录', true, 'MANUAL');
      INSERT INTO image_file (image_id, root_id, rel_path, mtime)
        SELECT id, 2, 'source-only.jpg', now() FROM image WHERE content_hash = 'source-only';
      INSERT INTO tag (category_id, name) VALUES (4, '测试标签');
      INSERT INTO image_tag (image_id, tag_id, status, source)
        SELECT id, 1, 'ACCEPTED', 'MANUAL' FROM image;
    `)
  } finally {
    await closeDatabase()
  }
  const { page } = await launchWithMockBailian(dirs)
  await page.locator('.side-nav__label:text-is("诺诺助手")').click()
  await page.getByRole('switch', { name: '包含 R-18' }).click()
  await page.locator('.assistant__input').fill('测试标签')
  await page.getByRole('button', { name: '发送' }).click()
  const cards = page.locator('.assistant__reply .assistant__pic')
  const pager = page.getByRole('navigation', { name: '搜索结果分页' })
  await pager.waitFor({ timeout: 60_000 })
  expect(await cards.count()).toBe(24)
  expect(await page.locator('.assistant__how').innerText()).toContain('找到 2401 张')
  await pager.getByRole('button', { name: '末页' }).click()
  expect(await cards.count()).toBe(1)
  expect(await cards.first().innerText()).toBe('图片-1')
  expect(await pager.getByRole('button', { name: '下一页' }).isDisabled()).toBe(true)
  await pager.getByRole('button', { name: '上一页' }).click()
  expect(await cards.count()).toBe(24)
  await page.getByRole('button', { name: '新对话' }).click()
  await page.getByRole('button', { name: '对话记录' }).click()
  await page.locator('.assistant__hist-row').first().click()
  await pager.waitFor()
  expect(await pager.getByRole('button', { name: '首页' }).isDisabled()).toBe(true)
  expect(await cards.first().innerText()).toBe('图片-2401')
}, 150_000)
