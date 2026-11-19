import { describe, expect, it } from 'vitest'
import { groupConsecutive, layoutRows, monthLabel, TILE_CHROME, TILE_GAP } from '../../src/renderer/src/utils/gridLayout'

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

  it('一张就超宽时单独一行并压到可用宽度', () => {
    const rows = layoutRows([{ id: 1, ratio: 2.5 }], 200, 140)
    expect(rows[0].tiles[0].width).toBe(200)
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
})
