import sharp from 'sharp'

// sharp 不支持 BMP，这里只解未压缩的 24/32 位 BMP（最常见的两种），其余（调色板、RLE 压缩）返回 null 按“无法预览”处理

// 解出的原始像素：sharp 的 raw 输入格式
export interface RawPixels {
  data: Buffer
  width: number
  height: number
  channels: 3 | 4
}

const BI_RGB = 0
const BI_BITFIELDS = 3

// 解码 BMP；不支持的变体或文件损坏返回 null
export function decodeBmp(buf: Buffer): RawPixels | null {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    return null
  }
  const pixelOffset = buf.readUInt32LE(10)
  const headerSize = buf.readUInt32LE(14)
  if (headerSize < 40) {
    return null
  }
  const width = buf.readInt32LE(18)
  const rawHeight = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  // 32 位的 BITFIELDS 常见的是标准 BGRA 排列，按 BI_RGB 处理
  const supported = (bpp === 24 && compression === BI_RGB) || (bpp === 32 && (compression === BI_RGB || compression === BI_BITFIELDS))
  if (!supported || width <= 0 || rawHeight === 0 || width > 30000 || Math.abs(rawHeight) > 30000) {
    return null
  }
  const height = Math.abs(rawHeight)
  // 高度为正时像素行从下往上存
  const bottomUp = rawHeight > 0
  const srcBytes = bpp / 8
  const rowStride = Math.ceil((width * bpp) / 32) * 4
  if (pixelOffset + rowStride * height > buf.length) {
    return null
  }
  const channels = bpp === 32 ? 4 : 3
  const out = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + (bottomUp ? height - 1 - y : y) * rowStride
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * srcBytes
      const d = (y * width + x) * channels
      out[d] = buf[s + 2]
      out[d + 1] = buf[s + 1]
      out[d + 2] = buf[s]
      if (channels === 4) {
        out[d + 3] = buf[s + 3]
      }
    }
  }
  // 32 位 BMP 的 alpha 常常全是 0（其实是没用到），这时当不透明
  if (channels === 4 && !out.some((v, i) => i % 4 === 3 && v !== 0)) {
    for (let i = 3; i < out.length; i += 4) {
      out[i] = 255
    }
  }
  return { data: out, width, height, channels }
}

export function openBmp(data: Buffer): ReturnType<typeof sharp> | null {
  const pixels = decodeBmp(data)
  return pixels && sharp(pixels.data, { raw: { width: pixels.width, height: pixels.height, channels: pixels.channels } })
}
