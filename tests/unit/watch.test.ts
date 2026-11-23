import { describe, expect, it } from 'vitest'
import { isIgnoredChange, isRootGoneSignal, isSelfChange, muteWhile, SELF_CHANGE_GRACE_MS } from '../../src/main/services/scan/watchService'

describe('实时监听', () => {
  it('被监听的目录自己被删时报的是带 \\?\ 前缀的绝对路径，普通变化是相对路径', () => {
    expect(isRootGoneSignal('\\\\?\\D:\\pics')).toBe(true)
    expect(isRootGoneSignal('D:\\pics')).toBe(true)
    expect(isRootGoneSignal('sub\\a.jpg')).toBe(false)
    expect(isRootGoneSignal('')).toBe(false)
  })

  it('只核对图片变更和可能涉及目录的重命名', () => {
    expect(isIgnoredChange('a.JPG', false)).toBe(false)
    expect(isIgnoredChange('sub\\deep\\b.webp', false)).toBe(false)
    expect(isIgnoredChange('note.txt', false)).toBe(true)
    expect(isIgnoredChange('sub', false)).toBe(true)
    expect(isIgnoredChange('新建文件夹', true)).toBe(false)
    expect(isIgnoredChange('2026.11', true)).toBe(false)
    expect(isIgnoredChange('.git\\index', true)).toBe(true)
    expect(isIgnoredChange('.thumbs\\x.jpg', false)).toBe(true)
    expect(isIgnoredChange('$RECYCLE.BIN\\x.jpg', true)).toBe(true)
    expect(isIgnoredChange('', false)).toBe(true)
  })

  it('应用自己改文件时和之后一小段时间不算外部变化', async () => {
    let inside = false
    await muteWhile(async () => {
      inside = isSelfChange()
    })
    expect(inside).toBe(true)
    expect(isSelfChange()).toBe(true)
    expect(isSelfChange(Date.now() + SELF_CHANGE_GRACE_MS + 10)).toBe(false)
  })
})
