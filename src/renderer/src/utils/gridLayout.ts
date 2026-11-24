// 五档目标行高，实际行高由容器宽度和图片比例决定。
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
  ratio: number
  width: number
  imageWidth: number
  crop: '' | '全景' | '长图'
}

export interface LayoutRow {
  height: number
  tiles: LayoutTile[]
}

// 一行最多放多少图片宽度（去掉卡片边框和空隙）
function availFor(width: number, n: number): number {
  return width - n * TILE_CHROME - (n - 1) * TILE_GAP
}

export function layoutRows(items: LayoutInput[], width: number, targetHeight: number): LayoutRow[] {
  const rows: LayoutRow[] = []
  if (width <= TILE_CHROME || targetHeight <= 0) return rows
  let pending: Array<{ id: number; ratio: number; crop: LayoutTile['crop'] }> = []
  let ratioSum = 0

  const finishRow = (height: number): void => {
    // 按累计位置取整，把像素误差分散到各张图片。
    let edge = 0
    const tiles = pending.map(({ id, ratio, crop }) => {
      const left = Math.round(edge)
      edge += ratio * height
      const imageWidth = Math.round(edge) - left
      return { id, ratio, width: imageWidth + TILE_CHROME, imageWidth, crop }
    })
    rows.push({ height, tiles })
    pending = []
    ratioSum = 0
  }

  for (const it of items) {
    const raw = Number.isFinite(it.ratio) && it.ratio > 0 ? it.ratio : 1
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw))
    const nextHeight = availFor(width, pending.length + 1) / (ratioSum + ratio)
    if (pending.length && nextHeight < targetHeight) {
      const currentHeight = availFor(width, pending.length) / ratioSum
      // 比较两种换行位置相对目标行高的缩放倍数。
      if (currentHeight * nextHeight < targetHeight * targetHeight) finishRow(currentHeight)
    }
    pending.push({ id: it.id, ratio, crop: raw > MAX_RATIO ? '全景' : raw < MIN_RATIO ? '长图' : '' })
    ratioSum += ratio
    const fittedHeight = availFor(width, pending.length) / ratioSum
    if (fittedHeight <= targetHeight) finishRow(fittedHeight)
  }
  if (pending.length) finishRow(targetHeight)
  return rows
}

export const PANEL_WIDTH = 300
export const PANEL_GAP = 14
export const ROW_INSET = 2

// 开合侧栏时保留行内顺序。窗口宽度和缩放档位决定换行，行高随图库的实际宽度连续变化。
export function fluidGalleryRows(items: LayoutInput[], fullWidth: number, targetHeight: number) {
  const reference = Math.max(TILE_CHROME + 1, fullWidth - (PANEL_WIDTH + PANEL_GAP) / 2)
  const rows = layoutRows(items, reference, targetHeight * Math.sqrt(reference / fullWidth))
  return rows.map((row, i) => {
    const ratioSum = row.tiles.reduce((sum, tile) => sum + tile.ratio, 0)
    const fixed = 2 * ROW_INSET + row.tiles.length * TILE_CHROME + (row.tiles.length - 1) * TILE_GAP
    const fit = `calc((100% - ${fixed}px) / ${ratioSum})`
    // 末行未填满时限制行高，避免一两张图片被放大到占满整行。
    const sparse = i === rows.length - 1 && ratioSum * row.height < reference - fixed + 2 * ROW_INSET - 1
    const cap = `calc(${targetHeight / 2}px + (100% - ${ROW_INSET * 2}px) * ${targetHeight / (2 * fullWidth)})`
    return { ...row, imageHeight: sparse ? `min(${fit}, ${cap})` : fit }
  })
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
