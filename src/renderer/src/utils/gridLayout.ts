// 图片网格排版（照原型 gridGroups）：每行同一高度，宽度按长宽比；行末“整行压窄”或“把最后一张挪到下一行、整行撑宽”取变形小的；最后一行不拉伸

// 5 档缩略图高度（Ctrl + 滚轮切换），大约每行 3 到 8 张
export const ROW_HEIGHTS = [210, 170, 140, 115, 92] as const
export const DEFAULT_ZOOM = 2
// 同一行相邻两张之间的空隙
export const TILE_GAP = 8
// 一张缩略图卡片除了图片以外占的宽度：内边距 6×2 + 描边 2×2
export const TILE_CHROME = 16
// 长宽比限制：超出时只显示中间部分
const MIN_RATIO = 0.5
const MAX_RATIO = 2.5

// 排版的输入：一张图的 id 和长宽比（宽 / 高，未知时按 1）
export interface LayoutInput {
  id: number
  ratio: number
}

// 排好的一张：卡片宽度（含边框内边距）、图片区宽度，以及超宽超长时的角标
export interface LayoutTile {
  id: number
  width: number
  imageWidth: number
  crop: '' | '全景' | '长图'
}

export interface LayoutRow {
  tiles: LayoutTile[]
}

// 一行最多放多少图片宽度（去掉卡片边框和空隙）
function availFor(width: number, n: number): number {
  return width - n * TILE_CHROME - (n - 1) * TILE_GAP
}

// 把一组图排成行。width 是行的可用宽度，height 是图片区高度
export function layoutRows(items: LayoutInput[], width: number, height: number): LayoutRow[] {
  const rows: LayoutRow[] = []
  let cur: Array<{ id: number; r: number; crop: LayoutTile['crop'] }> = []
  const sum = (arr: typeof cur): number => arr.reduce((m, c) => m + c.r * height, 0)

  // 按缩放系数 f 定下一行；f 不是 1 时最后一张补齐剩余宽度，保证右边对齐
  const flush = (arr: typeof cur, f: number): void => {
    const avail = availFor(width, arr.length)
    let used = 0
    const tiles = arr.map((c, k) => {
      const w = k === arr.length - 1 && f !== 1 ? Math.max(1, avail - used) : Math.max(1, Math.floor(c.r * height * f))
      used += w
      return { id: c.id, width: w + TILE_CHROME, imageWidth: w, crop: c.crop }
    })
    rows.push({ tiles })
  }

  for (const it of items) {
    const raw = Number.isFinite(it.ratio) && it.ratio > 0 ? it.ratio : 1
    const r = Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw))
    cur.push({ id: it.id, r, crop: raw > MAX_RATIO ? '全景' : raw < MIN_RATIO ? '长图' : '' })
    const n = cur.length
    if (sum(cur) <= availFor(width, n)) {
      continue
    }
    if (n === 1) {
      flush(cur, availFor(width, 1) / sum(cur))
      cur = []
      continue
    }
    const without = cur.slice(0, -1)
    const shrink = availFor(width, n) / sum(cur)
    const grow = availFor(width, n - 1) / sum(without)
    if (Math.abs(Math.log(shrink)) <= Math.abs(Math.log(grow))) {
      flush(cur, shrink)
      cur = []
    } else {
      flush(without, grow)
      cur = [cur[n - 1]]
    }
  }
  if (cur.length > 0) {
    flush(cur, 1)
  }
  return rows
}

// 分组用的月份键：YYYY-MM（本机时区）；没有时间时为 'none'
export function monthKey(iso: string | null): string {
  if (!iso) {
    return 'none'
  }
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// 月份标题：“2026 年 11 月”；没有拍摄时间的一组叫“没有拍摄时间”
export function monthLabel(key: string): string {
  return key === 'none' ? '没有拍摄时间' : `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`
}

// 把已经排好序的列表按键切成连续的几段（排序保证同一个月的图挨在一起）
export function groupConsecutive<T>(items: T[], keyOf: (item: T) => string): Array<{ key: string; items: T[] }> {
  const groups: Array<{ key: string; items: T[] }> = []
  for (const it of items) {
    const key = keyOf(it)
    const last = groups[groups.length - 1]
    if (last && last.key === key) {
      last.items.push(it)
    } else {
      groups.push({ key, items: [it] })
    }
  }
  return groups
}
