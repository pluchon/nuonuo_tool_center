import { constants } from 'node:fs'
import { copyFile, link } from 'node:fs/promises'
import { retryOnWinBusy } from './winFs'

// 同盘优先创建硬链接。跨卷或不支持硬链接的文件系统使用排他复制，保留已有同名文件。
export async function publishExclusive(source: string, target: string): Promise<void> {
  try {
    await retryOnWinBusy(() => link(source, target))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err
    await retryOnWinBusy(() => copyFile(source, target, constants.COPYFILE_EXCL))
  }
}
