import type { Page } from 'playwright'

// 在导入对话框里按路径逐层展开，最后点中目标文件夹（select 为 false 时只展开不点，用于不能选的文件夹）。
// path 形如 D:\ltm-dev\e2e\case\pics（D 盘打开时已自动展开）
export async function pickFolder(page: Page, path: string, select = true): Promise<void> {
  const [drive, ...parts] = path.split('\\')
  await page.waitForSelector('.folder-pick')
  let node = page.locator('.folder-pick__tree > .el-tree-node').filter({ has: page.locator(`.folder-pick__label:text-is("${drive} 盘")`) })
  for (let i = 0; i < parts.length; i++) {
    const expanded = (await node.getAttribute('aria-expanded')) === 'true'
    if (!expanded) {
      await node.locator('> .el-tree-node__content .el-tree-node__expand-icon').click()
    }
    const child = node
      .locator('> .el-tree-node__children > .el-tree-node')
      .filter({ has: page.locator(`> .el-tree-node__content .folder-pick__label:text-is("${parts[i]}")`) })
    await child.waitFor()
    node = child
  }
  const row = node.locator('> .el-tree-node__content .folder-pick__row')
  if (select) {
    await row.click()
  } else {
    await row.waitFor()
  }
}
