import { execFileSync } from 'node:child_process'
import { openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs'
import { basename } from 'node:path'

// 应用自己的数据库锁：记录真实 PID 和进程名。PGlite 的 postmaster.pid 永远是假 PID（-42），崩溃后会残留，不能拿来判断占用
export interface LockInfo {
  pid: number
  exe: string
  startedAt: string
}

// 加锁结果：拿到锁，或被另一个仍在运行的进程占用
export type LockResult = { ok: true } | { ok: false; holder: LockInfo }

// 判断某个 PID 是否还是一个同名进程在跑；用于识别“锁文件残留，但 PID 被别的程序复用”的情况
export type ProcessProbe = (pid: number, exe: string) => boolean

// 默认探测：先用信号 0 看 PID 是否存在，Windows 上再用 tasklist 核对进程名；查询本身失败时按“仍在运行”保守处理
export const defaultProcessProbe: ProcessProbe = (pid, exe) => {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') {
      return false
    }
  }
  if (process.platform !== 'win32' || !exe) {
    return true
  }
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    const name = /^"([^"]+)"/m.exec(out)?.[1]
    return name ? name.toLowerCase() === exe.toLowerCase() : false
  } catch {
    return true
  }
}

// 读锁文件；内容损坏时视为没有有效持有者
function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return { pid: parsed.pid, exe: String(parsed.exe ?? ''), startedAt: String(parsed.startedAt ?? '') }
    }
  } catch {
    // 读不到或不是 JSON
  }
  return null
}

// 以“不存在才创建”的方式写锁文件，保证两个进程不会同时拿到锁
function tryCreate(file: string, info: LockInfo): boolean {
  let fd: number
  try {
    fd = openSync(file, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw err
  }
  try {
    writeSync(fd, JSON.stringify(info))
  } finally {
    closeSync(fd)
  }
  return true
}

// 加锁：已被自己持有直接成功；持有者还在运行则失败；持有者已不在（崩溃残留）则清掉旧锁再加
export function acquireDbLock(file: string, probe: ProcessProbe = defaultProcessProbe): LockResult {
  const me: LockInfo = { pid: process.pid, exe: basename(process.execPath), startedAt: new Date().toISOString() }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(file, me)) {
      return { ok: true }
    }
    const holder = readLock(file)
    if (holder && holder.pid === me.pid) {
      return { ok: true }
    }
    if (holder && probe(holder.pid, holder.exe)) {
      return { ok: false, holder }
    }
    rmSync(file, { force: true })
  }
  throw new Error('锁文件反复被其他进程创建，无法加锁')
}

// 释放锁：只删除自己持有的锁，避免误删别的进程刚写下的锁
export function releaseDbLock(file: string): void {
  const holder = readLock(file)
  if (holder && holder.pid === process.pid) {
    rmSync(file, { force: true })
  }
}
