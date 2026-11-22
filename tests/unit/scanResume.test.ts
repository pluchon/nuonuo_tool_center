import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { ScanStateVO } from '@shared/api'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { loadCheckpoint, saveCheckpoint, SCAN_CHECKPOINT } from '../../src/main/services/progressCheckpoint'
import { configureScan, getScanState, onScanState, resumeScan, startScan, stopScan, stopScanAndWait, whenScanIdle } from '../../src/main/services/scan/scanService'

let dir: string
const pushed: ScanStateVO[] = []

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
  configureScan({ thumbsDir: join(dir, 'thumbs'), categoryHomeOverride: home })
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
