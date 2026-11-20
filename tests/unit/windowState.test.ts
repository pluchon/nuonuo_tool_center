import { describe, expect, it } from 'vitest'
import { fitToScreens, parseWindowState } from '../../src/main/window/windowState'

const MAIN = { x: 0, y: 0, width: 1920, height: 1040 }
const SIDE = { x: 1920, y: 0, width: 1920, height: 1040 }

describe('窗口位置记忆', () => {
  it('格式不对、缺宽高时当没有', () => {
    expect(parseWindowState('')).toBeNull()
    expect(parseWindowState('{坏了')).toBeNull()
    expect(parseWindowState('null')).toBeNull()
    expect(parseWindowState('{"width":"1280","height":800}')).toBeNull()
  })

  it('太小的宽高抬到最小尺寸，没有位置时只记大小', () => {
    expect(parseWindowState('{"width":300,"height":200,"maximized":true}')).toEqual({ x: null, y: null, width: 960, height: 600, maximized: true })
  })

  it('在屏幕里的位置原样保留', () => {
    const s = { x: 100, y: 80, width: 1280, height: 820, maximized: false }
    expect(fitToScreens(s, [MAIN])).toEqual(s)
  })

  it('副屏拔掉后去掉位置，居中打开', () => {
    const s = { x: 2200, y: 100, width: 1280, height: 820, maximized: false }
    expect(fitToScreens(s, [SIDE, MAIN])).toEqual(s)
    expect(fitToScreens(s, [MAIN])).toEqual({ ...s, x: null, y: null })
  })

  it('只露出一条边的不算看得见', () => {
    const s = { x: 1900, y: 100, width: 1280, height: 820, maximized: false }
    expect(fitToScreens(s, [MAIN]).x).toBeNull()
  })

  it('比屏幕还大的窗口缩到工作区以内', () => {
    const s = { x: 0, y: 0, width: 3000, height: 2000, maximized: false }
    expect(fitToScreens(s, [MAIN])).toMatchObject({ width: 1920, height: 1040 })
  })
})
