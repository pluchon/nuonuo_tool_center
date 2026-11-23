// 手写一张 24 位 BMP（左上角一个红点，其余蓝色）
export function bmp24(width: number, height: number): Buffer {
  const rowStride = Math.ceil((width * 24) / 32) * 4
  const buf = Buffer.alloc(54 + rowStride * height)
  buf.write('BM', 0)
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = 54 + (height - 1 - y) * rowStride + x * 3
      const red = x === 0 && y === 0
      buf[at] = red ? 0 : 255
      buf[at + 1] = 0
      buf[at + 2] = red ? 255 : 0
    }
  }
  return buf
}
