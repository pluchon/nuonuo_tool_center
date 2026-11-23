import type { Locator, Page } from 'playwright'

// 提前定位两个元素，按下后立即开始移动，避免定位耗时触发长按导出。
export async function dragToFolder(page: Page, tile: Locator, folder: Locator): Promise<void> {
  await tile.scrollIntoViewIfNeeded()
  await folder.scrollIntoViewIfNeeded()
  const [source, target] = await Promise.all([tile.boundingBox(), folder.boundingBox()])
  if (!source || !target) throw new Error('拖动的图片或目标目录不可见')
  const x = source.x + source.width / 2
  const y = source.y + source.height / 2
  const endX = target.x + target.width / 2
  const endY = target.y + target.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  try {
    await page.mouse.move(x + 12, y)
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.move(endX + 1, endY)
  } finally {
    await page.mouse.up()
  }
}
