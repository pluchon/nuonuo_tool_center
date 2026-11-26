import { describe, expect, it } from 'vitest'
import {
  binarySearchVisibleRows,
  computeVirtualRows,
  findMonthAtOffset,
  fluidGalleryRows,
  groupConsecutive,
  layoutRows,
  monthLabel,
  ROW_GAP,
  ROW_HEIGHT_EXTRA,
  ROW_INSET,
  TILE_CHROME,
  TILE_GAP
} from '../../src/renderer/src/utils/gridLayout'

// 一行实际占的宽度
function rowWidth(tiles: Array<{ width: number }>): number {
  return tiles.reduce((m, t) => m + t.width, 0) + (tiles.length - 1) * TILE_GAP
}

describe('网格排版', () => {
  it('除最后一行外每行都正好对齐右边；最后一行不拉伸', () => {
    const items = [1.5, 1, 0.75, 1.33, 2, 1, 1, 0.8].map((ratio, id) => ({ id, ratio }))
    const rows = layoutRows(items, 700, 140)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row.tiles)).toBe(700)
    }
    const last = rows[rows.length - 1]
    expect(rowWidth(last.tiles)).toBeLessThanOrEqual(700)
    expect(rows.flatMap((r) => r.tiles.map((t) => t.id))).toEqual(items.map((i) => i.id))
  })

  it('超宽超长按 0.5–2.5 夹住并打角标；没有尺寸的按方图', () => {
    const rows = layoutRows(
      [
        { id: 1, ratio: 5 },
        { id: 2, ratio: 0.2 },
        { id: 3, ratio: Number.NaN }
      ],
      2000,
      100
    )
    const [a, b, c] = rows[0].tiles
    expect([a.crop, b.crop, c.crop]).toEqual(['全景', '长图', ''])
    expect([a.imageWidth, b.imageWidth, c.imageWidth]).toEqual([250, 50, 100])
    expect(a.width).toBe(250 + TILE_CHROME)
  })

  it.each([445, 700, 1013])('宽度为 %i 时整行按比例缩放，末行不超过目标高度', width => {
    const items = [0.5, 1.6, 2.5, 0.8, 0.9, 1, 2.3, 1.4, 0.75].map((ratio, id) => ({ id, ratio }))
    const rows = layoutRows(items, width, 140)
    for (const row of rows) {
      for (const tile of row.tiles) {
        expect(Math.abs(tile.imageWidth - row.height * items[tile.id].ratio)).toBeLessThanOrEqual(1)
      }
    }
    expect(rows.at(-1)!.height).toBeLessThanOrEqual(140)
    for (const row of rows.slice(0, -1)) expect(rowWidth(row.tiles)).toBe(width)
  })

  it('单张超宽图即使移到末行也按比例缩小', () => {
    const rows = layoutRows([{ id: 1, ratio: 1.3 }, { id: 2, ratio: 2.5 }], 200, 140)
    expect(rows).toHaveLength(2)
    expect(rows[1].tiles[0].width).toBe(200)
    expect(rows[1].height).toBe((200 - TILE_CHROME) / 2.5)
  })

  it('按月分组：连续的同一个月归一组；没有时间的组标题', () => {
    const groups = groupConsecutive(['2026-11', '2026-11', '2026-10', 'none'], (k) => k)
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([
      ['2026-11', 2],
      ['2026-10', 1],
      ['none', 1]
    ])
    expect(monthLabel('2026-03')).toBe('2026 年 3 月')
    expect(monthLabel('none')).toBe('没有拍摄时间')
  })

  it('computeVirtualRows 精确计算每行像素高度、组内偏移和画布总高（含末行限高）', () => {
    const items = [
      { id: 1, ratio: 1.5 },
      { id: 2, ratio: 1.0 },
      { id: 3, ratio: 0.75 },
      { id: 4, ratio: 1.33 },
      { id: 5, ratio: 2.0 },
      { id: 6, ratio: 1.0 }
    ]
    const fullWidth = 1000
    const gridContentWidth = 700
    const targetHeight = 140
    const fluid = fluidGalleryRows(items, fullWidth, targetHeight)
    const layout = computeVirtualRows(fluid, gridContentWidth, fullWidth, targetHeight)

    expect(layout.rows).toHaveLength(fluid.length)
    let expectedOffset = 0
    for (let i = 0; i < fluid.length; i++) {
      const f = fluid[i]
      const g = layout.rows[i]
      const ratioSum = f.tiles.reduce((s, t) => s + t.ratio, 0)
      const fixed = 2 * ROW_INSET + f.tiles.length * TILE_CHROME + (f.tiles.length - 1) * TILE_GAP
      const fitPx = (gridContentWidth - fixed) / ratioSum
      const capPx = targetHeight / 2 + (gridContentWidth - 2 * ROW_INSET) * (targetHeight / (2 * fullWidth))
      const expectedImageH = f.sparse ? Math.min(fitPx, capPx) : fitPx

      expect(g.imageHeightPx).toBeCloseTo(expectedImageH, 6)
      expect(g.rowHeightPx).toBeCloseTo(expectedImageH + ROW_HEIGHT_EXTRA, 6)
      expect(g.offsetInGroup).toBeCloseTo(expectedOffset, 6)
      expectedOffset += g.rowHeightPx + (i < fluid.length - 1 ? ROW_GAP : 0)
    }
    expect(layout.canvasHeightPx).toBeCloseTo(expectedOffset, 6)
    expect(computeVirtualRows([], gridContentWidth, fullWidth, targetHeight)).toEqual({ rows: [], canvasHeightPx: 0 })

    // 单图稀疏末行应触发 capPx 限高而不是按 fitPx 撑爆
    const sparseFluid = fluidGalleryRows([{ id: 99, ratio: 1 }], 1000, 140)
    const sparseLayout = computeVirtualRows(sparseFluid, 900, 1000, 140)
    const capPx = 140 / 2 + (900 - 2 * ROW_INSET) * (140 / 2000)
    expect(sparseFluid[0].sparse).toBe(true)
    expect(sparseLayout.rows[0].imageHeightPx).toBeCloseTo(capPx, 6)
    expect(sparseLayout.canvasHeightPx).toBeCloseTo(capPx + ROW_HEIGHT_EXTRA, 6)
  })

  it('binarySearchVisibleRows 以 O(log N) 返回与 [scrollTop-overscan, scrollTop+viewport+overscan) 相交的半开区间', () => {
    expect(binarySearchVisibleRows([], 0, 800, 600)).toEqual({ start: 0, end: 0 })

    // 构造 100 行，每行高 180、间距 10（步长 190）
    const rows = Array.from({ length: 100 }, (_, i) => ({ top: i * 190, height: 180 }))
    // 顶部边界：scrollTop=0, viewport=500, overscan=600 -> 窗口 [-600, 1100)，第 5 行 top=950 < 1100，第 6 行 top=1140 >= 1100
    expect(binarySearchVisibleRows(rows, 0, 500, 600)).toEqual({ start: 0, end: 6 })

    // 中间窗口：scrollTop=3000, viewport=500, overscan=600 -> 窗口 [2400, 4100)
    // 第 12 行 [2280, 2460) 相交；第 11 行 [2090, 2270) 不相交；第 21 行 [3990, 4170) 相交；第 22 行 top=4180 >= 4100
    expect(binarySearchVisibleRows(rows, 3000, 500, 600)).toEqual({ start: 12, end: 22 })

    // 精确边界接触：top + height === minY 不算相交；top === maxY 不算相交
    expect(binarySearchVisibleRows(rows, 180, 190, 0)).toEqual({ start: 1, end: 2 })
    // 完全越过底部
    expect(binarySearchVisibleRows(rows, 30000, 500, 600)).toEqual({ start: 100, end: 100 })
    // 窗口完全在第一行之上
    expect(binarySearchVisibleRows([{ top: 1000, height: 100 }], 0, 500, 200)).toEqual({ start: 0, end: 0 })
  })

  it('findMonthAtOffset 以 O(log G) 二分查找当前滚动位置所属月份', () => {
    expect(findMonthAtOffset([], 0)).toBe('')
    const months = [
      { top: 0, label: '2026 年 11 月' },
      { top: 500, label: '2026 年 10 月' },
      { top: 1200, label: '2026 年 9 月' },
      { top: 2400, label: '没有拍摄时间' }
    ]
    expect(findMonthAtOffset(months, 0)).toBe('2026 年 11 月')
    expect(findMonthAtOffset(months, 491)).toBe('2026 年 11 月')
    expect(findMonthAtOffset(months, 492)).toBe('2026 年 10 月')
    expect(findMonthAtOffset(months, 1191)).toBe('2026 年 10 月')
    expect(findMonthAtOffset(months, 1192)).toBe('2026 年 9 月')
    expect(findMonthAtOffset(months, 9999)).toBe('没有拍摄时间')
  })
})
