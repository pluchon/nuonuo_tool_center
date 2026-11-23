import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { ScanStateVO } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { loadCheckpoint, saveCheckpoint, SCAN_CHECKPOINT } from '../../src/main/services/progressCheckpoint'
import { updateSettings } from '../../src/main/services/settingsService'
import { configureScan, getScanState, onScanState, requeueScan, resumeScan, runQueuedScans, startScan, stopScan, stopScanAndWait, whenScanIdle } from '../../src/main/services/scan/scanService'

let dir: string
const pushed: ScanStateVO[] = []
let allowAuto = true

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-scan-resume-'))
  const source = join(dir, 'pics')
  const home = join(dir, 'library')
  mkdirSync(source)
  mkdirSync(home)
  mkdirSync(join(dir, 'thumbs'))
  for (let i = 0; i < 5; i++) {
    await sharp({ create: { width: 40 + i, height: 30, channels: 3, background: '#7A63C9' } }).jpeg().toFile(join(source, `p${i}.jpg`))
  }
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
  await getDatabase().pg.query(`INSERT INTO library_root (kind, name, path) VALUES ('SOURCE', 'pics', $1)`, [source])
  configureScan({ thumbsDir: join(dir, 'thumbs'), categoryHomeOverride: home, canRunAuto: () => allowAuto })
  onScanState((s) => pushed.push(s))
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('扫描断点', () => {
  it('没有断点时不接着扫；有断点时启动就接着扫，进度从上次的数开始，扫完清掉断点', async () => {
    expect(await resumeScan()).toBe(false)
    await saveCheckpoint(SCAN_CHECKPOINT, { rootId: null, auto: true, done: 3, total: 5 })
    expect(await resumeScan()).toBe(true)
    await whenScanIdle()
    // 数完文件（总数 5）后的第一条进度就是上次的 3，之后不倒退
    const withTotal = pushed.map((s) => s.progress).filter((p) => p !== null && p.total === 5)
    expect(withTotal[0]).toMatchObject({ done: 3, total: 5 })
    const dones = withTotal.map((p) => p!.done)
    expect(dones).toEqual([...dones].sort((a, b) => a - b))
    expect(await loadCheckpoint(SCAN_CHECKPOINT)).toBeNull()
  })

  it('整理期间重复收到目录变化，只留一个自动重扫，放行后再执行', async () => {
    allowAuto = false
    pushed.length = 0
    requeueScan(1)
    requeueScan(1)
    requeueScan(1)
    await whenScanIdle()
    expect(pushed).toEqual([])
    allowAuto = true
    runQueuedScans()
    await whenScanIdle()
    expect(pushed.filter((s) => s.progress === null && s.last?.auto)).toHaveLength(1)
  })

  it('重启按断点里的过滤设置继续，用户修改的设置留给下一次新扫描', async () => {
    pushed.length = 0
    await updateSettings({ scanFormats: ['PNG'] })
    await saveCheckpoint(SCAN_CHECKPOINT, { rootId: 1, auto: false, done: 2, total: 5, startFileId: 2, filters: { scanFormats: ['JPG'], skipSmall: DEFAULT_SETTINGS.skipSmall } })
    try {
      expect(await resumeScan()).toBe(true)
      await whenScanIdle()
      expect(pushed.some(({ progress }) => progress?.total === 5 && progress.done === 2)).toBe(true)
      expect(getScanState().last?.added).toBe(3)
      expect(await loadCheckpoint(SCAN_CHECKPOINT)).toBeNull()
    } finally {
      await updateSettings({ scanFormats: DEFAULT_SETTINGS.scanFormats })
    }
  })

  it('手动停止不留断点；退出时还在扫的记下断点（扫哪个、扫到几、总数）', async () => {
    // 一开始扫就点“停止”
    onScanState((s) => {
      if (s.progress) {
        stopScan()
      }
    })
    startScan(null)
    await whenScanIdle()
    expect(await loadCheckpoint(SCAN_CHECKPOINT)).toBeNull()

    // 一开始扫就退出应用
    let quit: Promise<void> | null = null
    onScanState((s) => {
      if (s.progress && !quit) {
        quit = stopScanAndWait()
      }
    })
    startScan(null)
    await vi.waitFor(() => expect(quit).not.toBeNull())
    await quit
    expect(getScanState().progress).toBeNull()
    expect(await loadCheckpoint(SCAN_CHECKPOINT)).toMatchObject({ rootId: null, auto: false })
  })
})
