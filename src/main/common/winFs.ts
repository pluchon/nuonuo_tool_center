import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'

// Windows 下常见的瞬时文件占用错误码（杀毒软件扫描、索引器、资源管理器预览等）
const WIN_BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 判断是否为 Windows 瞬时文件锁错误
export function isWinBusyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && WIN_BUSY_CODES.has(code)
}

// 异步重试：仅在遇到 Windows 瞬时占用错误时按退避间隔重试，其他错误（如 ENOENT / EEXIST）立即抛出
export async function retryOnWinBusy<T>(fn: () => Promise<T>, delaysMs: number[] = [60, 180, 400]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isWinBusyError(err) || attempt >= delaysMs.length) {
        throw err
      }
      await sleep(delaysMs[attempt])
    }
  }
}

// 同步重试：用于窗口关闭等同步落盘场景，短暂停顿后重试瞬时占用错误
export function retryOnWinBusySync<T>(fn: () => T, retries = 3): T {
  const waitBuf = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null
  for (let attempt = 0; ; attempt++) {
    try {
      return fn()
    } catch (err) {
      if (!isWinBusyError(err) || attempt >= retries) {
        throw err
      }
      if (waitBuf) {
        Atomics.wait(waitBuf, 0, 0, 20 * (attempt + 1))
      }
    }
  }
}

// 原子写入：先写入同目录临时文件并 sync 落盘，再通过 retryOnWinBusy 改名覆盖目标文件；失败时清理临时文件
export async function atomicWriteFile(target: string, data: Buffer | string): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await retryOnWinBusy(() => rename(tmp, target))
  } catch (err) {
    await retryOnWinBusy(() => rm(tmp, { force: true })).catch(() => undefined)
    throw err
  }
}
