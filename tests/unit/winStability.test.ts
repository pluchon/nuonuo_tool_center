import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isWinBusyError, retryOnWinBusy, retryOnWinBusySync, atomicWriteFile } from '../../src/main/common/winFs'
import { splitWinPath, toPosixRel, winBasename } from '../../src/main/common/pathUtil'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { rotateAutoSnapshot } from '../../src/main/services/systemService'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() }, clipboard: {}, ClipboardItem: class {}, nativeImage: {}, shell: {} }))
const { nextCrashBackoffMs, configureRating, getVisualTagsForSearch, resetRatingDegradation, stopRating } = await import(
  '../../src/main/services/rating/ratingService'
)

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

describe('Windows 文件锁重试与原子写入', () => {
  it('isWinBusyError 只识别 EBUSY / EPERM / EACCES', () => {
    expect(isWinBusyError(errno('EBUSY'))).toBe(true)
    expect(isWinBusyError(errno('EPERM'))).toBe(true)
    expect(isWinBusyError(errno('EACCES'))).toBe(true)
    expect(isWinBusyError(errno('ENOENT'))).toBe(false)
    expect(isWinBusyError(errno('EEXIST'))).toBe(false)
    expect(isWinBusyError(new Error('plain'))).toBe(false)
    expect(isWinBusyError(null)).toBe(false)
  })

  it('retryOnWinBusy 会重试 EBUSY/EPERM/EACCES 并最终成功', async () => {
    const codes = ['EBUSY', 'EPERM', 'EACCES']
    let attempts = 0
    const res = await retryOnWinBusy(async () => {
      if (attempts < codes.length) {
        const code = codes[attempts++]
        throw errno(code)
      }
      attempts++
      return 'ok'
    }, [1, 1, 1])
    expect(res).toBe('ok')
    expect(attempts).toBe(4)
  })

  it('retryOnWinBusy 遇到 ENOENT / EEXIST 立即抛出不重试', async () => {
    for (const code of ['ENOENT', 'EEXIST']) {
      let attempts = 0
      await expect(
        retryOnWinBusy(async () => {
          attempts++
          throw errno(code)
        }, [10, 10, 10])
      ).rejects.toThrow(code)
      expect(attempts).toBe(1)
    }
  })

  it('retryOnWinBusy 超过最大重试次数后抛出最后一次瞬时错误', async () => {
    let attempts = 0
    await expect(
      retryOnWinBusy(async () => {
        attempts++
        throw errno('EBUSY', `busy-${attempts}`)
      }, [1, 1])
    ).rejects.toThrow('busy-3')
    expect(attempts).toBe(3)
  })

  it('retryOnWinBusySync 仅重试瞬时锁错误并在 ENOENT 时立即抛出', () => {
    let attempts = 0
    const val = retryOnWinBusySync(() => {
      attempts++
      if (attempts < 3) throw errno('EBUSY')
      return 42
    }, 3)
    expect(val).toBe(42)
    expect(attempts).toBe(3)

    let nonBusyAttempts = 0
    expect(() =>
      retryOnWinBusySync(() => {
        nonBusyAttempts++
        throw errno('ENOENT')
      }, 3)
    ).toThrow('ENOENT')
    expect(nonBusyAttempts).toBe(1)
  })

  it('atomicWriteFile 正常写入不残留临时文件，失败时清理 .tmp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ltm-winfs-'))
    try {
      const target = join(dir, 'state.json')
      await atomicWriteFile(target, '{"ok":1}')
      expect(readFileSync(target, 'utf8')).toBe('{"ok":1}')
      expect(readdirSync(dir)).toEqual(['state.json'])

      // 覆盖写新内容
      await atomicWriteFile(target, Buffer.from('{"ok":2}'))
      expect(readFileSync(target, 'utf8')).toBe('{"ok":2}')
      expect(readdirSync(dir)).toEqual(['state.json'])

      // rename 目标是一个目录导致失败时，应清理掉 .tmp 文件并抛出错误
      const dirAsTarget = join(dir, 'folder-target')
      mkdirSync(dirAsTarget)
      await expect(atomicWriteFile(dirAsTarget, 'fail')).rejects.toThrow()
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pathUtil 路径规范化纯函数', () => {
  it('splitWinPath / toPosixRel / winBasename 兼容反斜杠与正斜杠', () => {
    expect(splitWinPath('a\\b\\c.jpg')).toEqual(['a', 'b', 'c.jpg'])
    expect(splitWinPath('a/b\\c.jpg')).toEqual(['a', 'b', 'c.jpg'])
    expect(splitWinPath('')).toEqual([])
    expect(splitWinPath('a\\b\\')).toEqual(['a', 'b'])

    expect(toPosixRel('a\\b\\c.jpg')).toBe('a/b/c.jpg')
    expect(toPosixRel('a/b/c.jpg')).toBe('a/b/c.jpg')
    expect(toPosixRel('')).toBe('')

    expect(winBasename('a\\b\\c.jpg')).toBe('c.jpg')
    expect(winBasename('a/b/c.jpg')).toBe('c.jpg')
    expect(winBasename('single.png')).toBe('single.png')
    expect(winBasename('a\\b\\')).toBe('b')
    expect(winBasename('')).toBe('')
  })
})

describe('本地分级进程故障隔离', () => {
  it('nextCrashBackoffMs 返回 [1000, 3000, 8000]，超过 3 次返回 null 触发降级', () => {
    expect(nextCrashBackoffMs(1)).toBe(1000)
    expect(nextCrashBackoffMs(2)).toBe(3000)
    expect(nextCrashBackoffMs(3)).toBe(8000)
    expect(nextCrashBackoffMs(4)).toBeNull()
    expect(nextCrashBackoffMs(10)).toBeNull()
  })

  it('连续异常退出超过 3 次后进入降级状态，不再 fork 子进程，resume/reset 后恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ltm-rating-iso-'))
    const store = await import('../../src/main/services/rating/modelStore')
    const ready = vi.spyOn(store, 'isModelReady').mockResolvedValue(true)
    const { utilityProcess } = await import('electron')
    const forkMock = vi.mocked(utilityProcess.fork)
    forkMock.mockReset()
    try {
      await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
      const { pg } = getDatabase()
      await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('CATEGORY', '类目录', $1)`, [dir])
      await pg.exec(`
        INSERT INTO image (content_hash, format, byte_size, thumb_ready) VALUES ('h_crash', 'JPG', 1, 1);
        INSERT INTO image_file (image_id, root_id, rel_path, mtime) VALUES (1, 1, 'sub/a.jpg', now());
        INSERT INTO tag (name, category_id) VALUES ('测试降级标签', 4);
        INSERT INTO image_tag (image_id, tag_id, source, status) VALUES (1, 1, 'MANUAL', 'ACCEPTED');
      `)
      configureRating({ modelsRoot: dir, thumbsDir: dir, workerPath: '', canRun: () => true, onR18: () => {}, threshold: 0.5, onDone: () => {} })

      // 模拟第 1/2/3/4 次崩溃（mock setTimeout 立即执行退避等待，加速测试）
      const backoffSeen: number[] = []
      const origSetTimeout = globalThis.setTimeout
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (typeof ms === 'number' && ms > 500 && ms <= 8000) {
          backoffSeen.push(ms)
          return origSetTimeout(fn, 1, ...args)
        }
        return origSetTimeout(fn, ms, ...args)
      }) as typeof setTimeout)

      try {
        forkMock.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(),
            postMessage: vi.fn(() => {
              queueMicrotask(() => child.emit('exit', 1))
            })
          })
          return child as unknown as ReturnType<typeof utilityProcess.fork>
        })

        for (let i = 0; i < 4; i++) {
          expect(await getVisualTagsForSearch(1)).toBeNull()
        }
        expect(forkMock).toHaveBeenCalledTimes(4)
        expect(backoffSeen).toHaveLength(3)
        expect(backoffSeen[0]).toBeGreaterThan(500)
        expect(backoffSeen[0]).toBeLessThanOrEqual(1000)
        expect(backoffSeen[1]).toBeGreaterThan(2000)
        expect(backoffSeen[1]).toBeLessThanOrEqual(3000)
        expect(backoffSeen[2]).toBeGreaterThan(7000)
        expect(backoffSeen[2]).toBeLessThanOrEqual(8000)

        // 此时已处于 workerDegraded：再次请求不应再 fork
        expect(await getVisualTagsForSearch(1)).toBeNull()
        expect(forkMock).toHaveBeenCalledTimes(4)

        // resetRatingDegradation() 后可恢复工作进程
        resetRatingDegradation()
        forkMock.mockImplementation(() => {
          const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(),
            postMessage: vi.fn(({ id }: { id: number }) => {
              queueMicrotask(() => child.emit('message', { id, ok: true, scores: {}, tags: ['recovered'] }))
            })
          })
          return child as unknown as ReturnType<typeof utilityProcess.fork>
        })
        expect(await getVisualTagsForSearch(1)).toEqual(['recovered'])
        expect(forkMock).toHaveBeenCalledTimes(5)
      } finally {
        timeoutSpy.mockRestore()
        await stopRating()
        await closeDatabase()
      }
    } finally {
      ready.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('rotateAutoSnapshot 元数据自动快照轮转', () => {
  let dir: string
  let snapshotsDir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ltm-snap-'))
    snapshotsDir = join(dir, 'snapshots')
    await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
    const { pg } = getDatabase()
    await pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [dir])
  })

  afterAll(async () => {
    await closeDatabase()
    rmSync(dir, { recursive: true, force: true })
  })

  it('清理残留 .tmp，24 小时内跳过，超过间隔生成新快照并保留最近 3 份', async () => {
    mkdirSync(snapshotsDir, { recursive: true })
    writeFileSync(join(snapshotsDir, 'stray.tmp'), 'junk')
    writeFileSync(join(snapshotsDir, 'auto-20261120-080000.tar.gz'), 's1')
    writeFileSync(join(snapshotsDir, 'auto-20261121-080000.tar.gz'), 's2')
    writeFileSync(join(snapshotsDir, 'auto-20261122-080000.tar.gz'), 's3')

    // 12 小时内不重复生成，但仍清理残留 .tmp
    const skipped = await rotateAutoSnapshot(snapshotsDir, { now: new Date(2026, 10, 22, 20, 0, 0) })
    expect(skipped).toBeNull()
    expect(existsSync(join(snapshotsDir, 'stray.tmp'))).toBe(false)
    expect(readdirSync(snapshotsDir).sort()).toEqual([
      'auto-20261120-080000.tar.gz',
      'auto-20261121-080000.tar.gz',
      'auto-20261122-080000.tar.gz'
    ])

    // 24 小时后生成新快照并淘汰最旧的 auto-20261120-080000.tar.gz
    const created = await rotateAutoSnapshot(snapshotsDir, { now: new Date(2026, 10, 23, 9, 30, 5) })
    expect(created).toBe(join(snapshotsDir, 'auto-20261123-093005.tar.gz'))
    expect(existsSync(created!)).toBe(true)
    expect(readdirSync(snapshotsDir).sort()).toEqual([
      'auto-20261121-080000.tar.gz',
      'auto-20261122-080000.tar.gz',
      'auto-20261123-093005.tar.gz'
    ])
  })
})
