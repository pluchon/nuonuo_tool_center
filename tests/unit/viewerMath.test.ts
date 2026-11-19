import { describe, expect, it } from 'vitest'
import { actualZoom, canShowOriginal, clampZoom, fitScale, isSideways, zoomCeil } from '../../src/renderer/src/utils/viewerMath'

describe('大图缩放计算', () => {
  it('适应窗口：整张放得下，小图不放大', () => {
    // 全景图按宽度缩，长图按高度缩
    expect(fitScale(4000, 500, 1000, 500, 0)).toBeCloseTo(0.25)
    expect(fitScale(400, 3000, 1000, 600, 0)).toBeCloseTo(0.2)
    expect(fitScale(200, 100, 1000, 600, 0)).toBe(1)
    // 量不到尺寸时按 1 倍
    expect(fitScale(0, 0, 1000, 600, 0)).toBe(1)
  })

  it('转 90° 时宽高对调', () => {
    expect(isSideways(90)).toBe(true)
    expect(isSideways(-90)).toBe(true)
    expect(isSideways(180)).toBe(false)
    expect(isSideways(-270)).toBe(true)
    expect(fitScale(4000, 500, 1000, 500, 90)).toBeCloseTo(0.125)
  })

  it('原始大小和缩放范围', () => {
    expect(actualZoom(0.25)).toBe(400)
    expect(actualZoom(1)).toBe(100)
    // 原始大小超过 400% 的大图放宽上限
    expect(zoomCeil(0.1)).toBe(1000)
    expect(zoomCeil(0.5)).toBe(400)
    expect(clampZoom(10, 0.5)).toBe(25)
    expect(clampZoom(900, 0.5)).toBe(400)
    expect(clampZoom(900, 0.1)).toBe(900)
  })

  it('浏览器能直接显示的格式', () => {
    expect(canShowOriginal('JPG')).toBe(true)
    expect(canShowOriginal('AVIF')).toBe(true)
    expect(canShowOriginal('HEIC')).toBe(false)
    expect(canShowOriginal('RAW')).toBe(false)
  })
})
