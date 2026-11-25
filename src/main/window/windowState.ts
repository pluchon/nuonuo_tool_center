import type { BrowserWindow, Rectangle } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { getLogger } from '../common/logger'
import { retryOnWinBusySync } from '../common/winFs'

const log = getLogger('window')

// 上次关闭时窗口的位置、大小（还原状态下的）和是否最大化
export interface WindowState {
  x: number | null
  y: number | null
  width: number
  height: number
  maximized: boolean
}

// 窗口最小尺寸（和创建窗口时的 minWidth / minHeight 一致）
export const MIN_WIDTH = 960
export const MIN_HEIGHT = 600
// 窗口至少有这么大一块露在某个屏幕的工作区里才算“看得见”，否则放回屏幕中间
const VISIBLE_W = 160
const VISIBLE_H = 80
// 拖动、缩放停下这么久再写文件
const SAVE_DELAY_MS = 600

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// 解析存下来的内容：格式不对就当没有
export function parseWindowState(raw: string): WindowState | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const d = data as Record<string, unknown>
  if (!isNum(d.width) || !isNum(d.height)) {
    return null
  }
  const hasPos = isNum(d.x) && isNum(d.y)
  return {
    x: hasPos ? Math.round(d.x as number) : null,
    y: hasPos ? Math.round(d.y as number) : null,
    width: Math.max(MIN_WIDTH, Math.round(d.width)),
    height: Math.max(MIN_HEIGHT, Math.round(d.height)),
    maximized: d.maximized === true
  }
}

// 放到现在的屏幕上：大小不超过所在屏幕的工作区；拔掉了副屏、改了分辨率导致看不见时去掉位置（居中打开）
export function fitToScreens(state: WindowState, workAreas: Rectangle[]): WindowState {
  if (workAreas.length === 0) {
    return state
  }
  const overlap = (a: Rectangle): { w: number; h: number } => {
    if (state.x === null || state.y === null) {
      return { w: 0, h: 0 }
    }
    const w = Math.min(state.x + state.width, a.x + a.width) - Math.max(state.x, a.x)
    const h = Math.min(state.y + state.height, a.y + a.height) - Math.max(state.y, a.y)
    return { w, h }
  }
  let host: Rectangle | undefined
  let largest = 0
  for (const area of workAreas) {
    const { w, h } = overlap(area)
    if (w >= VISIBLE_W && h >= VISIBLE_H && w * h > largest) {
      host = area
      largest = w * h
    }
  }
  const area = host ?? workAreas[0]
  const width = Math.min(state.width, Math.max(MIN_WIDTH, area.width))
  const height = Math.min(state.height, Math.max(MIN_HEIGHT, area.height))
  if (!host) {
    return { ...state, x: null, y: null, width, height }
  }
  // 上方显示器断开或缩放改变后，窗口下半部可能仍可见，但标题栏已在屏幕外。
  const y = state.y
  const titleVisible = y !== null && workAreas.some((a) => y >= a.y && y + 32 <= a.y + a.height && overlap(a).w >= VISIBLE_W)
  return { ...state, y: titleVisible ? y : host.y, width, height }
}

// 读上次的窗口状态；没有或读不了时返回 null（用默认大小居中）
export function loadWindowState(file: string, workAreas: Rectangle[]): WindowState | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const parsed = parseWindowState(raw)
  return parsed ? fitToScreens(parsed, workAreas) : null
}

// 记住窗口：拖动、缩放、最大化后停一会儿写一次，关窗口时再写一次；最小化时不记
export function trackWindowState(win: BrowserWindow, file: string): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (win.isDestroyed() || win.isMinimized()) {
      return
    }
    const b = win.getNormalBounds()
    const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(state), { flush: true })
      retryOnWinBusySync(() => renameSync(tmp, file))
    } catch (err) {
      log.warn('记不下窗口位置', err)
      try {
        rmSync(tmp, { force: true })
      } catch (cleanupError) {
        log.warn('清理窗口状态临时文件失败', cleanupError)
      }
    }
  }
  const later = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(save, SAVE_DELAY_MS)
  }
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    win.on(ev as 'resize', later)
  }
  win.on('close', save)
}
