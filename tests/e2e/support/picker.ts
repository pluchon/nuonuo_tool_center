import type { ElectronApplication, Page } from 'playwright'

// 导入源目录、重新选择位置、复制 / 移动到其他位置都用 Windows 自己的选文件夹对话框；
// 测试里不能真弹出来，把主进程的 dialog.showOpenDialog 换成直接返回给定路径（之后每次都返回它）
export async function stubFolderPick(app: ElectronApplication, path: string | null): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => (p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] })) as unknown as typeof dialog.showOpenDialog
  }, path)
}

// 侧栏入口在首次启动及已有类目录的图库中都可用。
export async function importFolder(app: ElectronApplication, page: Page, path: string, trigger = '.side-nav__add[aria-label="导入源目录"]'): Promise<void> {
  await stubFolderPick(app, path)
  await page.click(trigger)
}
