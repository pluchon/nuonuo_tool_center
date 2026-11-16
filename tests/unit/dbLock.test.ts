import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDbLock, defaultProcessProbe, releaseDbLock } from '../../src/main/db/dbLock'

let dir: string
let file: string

const otherHolder = JSON.stringify({ pid: 999999, exe: 'electron.exe', startedAt: '' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-lock-'))
  file = join(dir, 'ltm.lock')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('数据库锁', () => {
  it('没有锁时直接拿到，锁里记的是真实 PID', () => {
    expect(acquireDbLock(file, () => true)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid)
  })

  it('自己已经持有时再加锁也成功', () => {
    acquireDbLock(file, () => true)
    expect(acquireDbLock(file, () => true)).toEqual({ ok: true })
  })

  it('持有者还在运行时返回被占用', () => {
    writeFileSync(file, otherHolder)
    const result = acquireDbLock(file, () => true)
    expect(result.ok).toBe(false)
    expect(result.ok ? 0 : result.holder.pid).toBe(999999)
  })

  it('持有者已经不在（崩溃残留）时清掉旧锁再加', () => {
    writeFileSync(file, otherHolder)
    expect(acquireDbLock(file, () => false)).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid)
  })

  it('锁文件内容损坏时按残留处理', () => {
    writeFileSync(file, 'not json')
    expect(acquireDbLock(file, () => true)).toEqual({ ok: true })
  })

  it('只释放自己的锁，不删别人的', () => {
    writeFileSync(file, otherHolder)
    releaseDbLock(file)
    expect(existsSync(file)).toBe(true)
    rmSync(file)
    acquireDbLock(file, () => true)
    releaseDbLock(file)
    expect(existsSync(file)).toBe(false)
  })
})

describe('默认进程探测', () => {
  it('当前进程按名字能认出来', () => {
    expect(defaultProcessProbe(process.pid, basename(process.execPath))).toBe(true)
  })

  it('PID 还在但进程名对不上时不算占用（PID 被别的程序复用）', () => {
    expect(defaultProcessProbe(process.pid, 'definitely-not-this.exe')).toBe(process.platform !== 'win32')
  })

  it('不存在的 PID 不算占用', () => {
    expect(defaultProcessProbe(2147483, 'electron.exe')).toBe(false)
  })
})
