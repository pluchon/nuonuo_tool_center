// 相机 RAW 文件里一般都嵌着一张或几张 JPEG 预览图（ARW/NEF/CR2/DNG 是 TIFF 结构，CR3/RAF 也带），
// 这里按 JPEG 标记扫出所有完整的 JPEG，取最大的那张做缩略图和尺寸来源

// 太小的多半是 160×120 的小缩略图，不要
const MIN_PREVIEW_BYTES = 16 * 1024

// 从 start（SOI 的位置）开始按段解析一张 JPEG，返回结束位置（EOI 之后），解析不通返回 -1
function jpegEnd(buf: Buffer, start: number): number {
  let i = start + 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) {
      return -1
    }
    const marker = buf[i + 1]
    // 段之间允许多个 0xFF 填充
    if (marker === 0xff) {
      i += 1
      continue
    }
    if (marker === 0xd9) {
      return i + 2
    }
    // 没有长度字段的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) {
      return -1
    }
    i += 2 + len
    if (marker === 0xda) {
      // 扫描数据：找到不是填充（FF00）也不是 RST 的 FF xx 为止
      while (i + 1 < buf.length) {
        if (buf[i] === 0xff) {
          const next = buf[i + 1]
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            i += next === 0xff ? 1 : 2
            continue
          }
          break
        }
        i += 1
      }
    }
  }
  return -1
}

// 取 RAW 文件里最大的内嵌 JPEG；没有时返回 null
export function largestEmbeddedJpeg(buf: Buffer): Buffer | null {
  let best: Buffer | null = null
  let from = 0
  for (;;) {
    const soi = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), from)
    if (soi < 0) {
      break
    }
    const end = jpegEnd(buf, soi)
    if (end < 0) {
      from = soi + 2
      continue
    }
    const size = end - soi
    if (size >= MIN_PREVIEW_BYTES && (!best || size > best.length)) {
      best = buf.subarray(soi, end)
    }
    from = end
  }
  return best
}

// RAW 文件本身是不是 TIFF 头（EXIF 可以直接从文件开头读）
export function hasTiffHeader(buf: Buffer): boolean {
  if (buf.length < 4) {
    return false
  }
  const le = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00
  const be = buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a
  return le || be
}
