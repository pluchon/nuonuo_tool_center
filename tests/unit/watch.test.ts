import { describe, expect, it } from 'vitest'
import { isIgnoredChange, isSelfChange, muteWhile, rootOf, SELF_CHANGE_GRACE_MS } from '../../src/main/services/scan/watchService'

describe('实时监听', () => {
  it('只关心图片文件和普通文件夹', () => {
    expect(isIgnoredChange('a.JPG')).toBe(false)
    expect(isIgnoredChange('sub\\deep\\b.webp')).toBe(false)
    expect(isIgnoredChange('note.txt')).toBe(true)
    // 没有扩展名的当文件夹
    expect(isIgnoredChange('sub')).toBe(false)
    expect(isIgnoredChange('新建文件夹')).toBe(false)
    expect(isIgnoredChange('.git\\index')).toBe(true)
    expect(isIgnoredChange('.thumbs\\x.jpg')).toBe(true)
    expect(isIgnoredChange('$RECYCLE.BIN\\x.jpg')).toBe(true)
    expect(isIgnoredChange('')).toBe(false)
  })

  it('变化落在哪个目录：不区分大小写，取最长的那个', () => {
    const roots = new Map([
      [1, 'D:\\Pics'],
      [2, 'D:\\Pics\\Nested'],
      [3, 'E:\\library']
    ])
    expect(rootOf('d:\\pics\\a.jpg', roots)).toBe(1)
    expect(rootOf('D:\\Pics\\Nested\\x\\b.png', roots)).toBe(2)
    expect(rootOf('E:\\library', roots)).toBe(3)
    expect(rootOf('D:\\Other\\c.jpg', roots)).toBeNull()
    expect(rootOf('D:\\Pics2\\c.jpg', roots)).toBeNull()
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
