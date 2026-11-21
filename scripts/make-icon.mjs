// 由 resources/icon.png 生成 Windows 用的多尺寸 resources/icon.ico（窗口、任务栏、桌面快捷方式用），以及标题栏左上角用的小图
// 用法：node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const source = 'resources/icon.png'
const target = 'resources/icon.ico'
// 标题栏图标显示 24px，按 4 倍屏出 96px
const brand = 'src/renderer/src/assets/brand/app-icon.png'
const BRAND_SIZE = 96

// 每个尺寸一张 PNG（ICO 允许直接内嵌 PNG）；固定写 96 DPI，源图的分辨率字段坏了（横向为 0）时 Windows 会整份拒读
const images = []
for (const size of SIZES) {
  images.push({ size, data: await sharp(source).resize(size, size, { kernel: 'lanczos3' }).withMetadata({ density: 96 }).png({ compressionLevel: 9 }).toBuffer() })
}

// ICO 文件头 6 字节 + 每张 16 字节的目录，然后依次是图片数据
const header = Buffer.alloc(6 + images.length * 16)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = header.length
images.forEach((img, i) => {
  const at = 6 + i * 16
  // 256 在目录里记成 0
  header.writeUInt8(img.size === 256 ? 0 : img.size, at)
  header.writeUInt8(img.size === 256 ? 0 : img.size, at + 1)
  header.writeUInt8(0, at + 2)
  header.writeUInt8(0, at + 3)
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(img.data.length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += img.data.length
})
writeFileSync(target, Buffer.concat([header, ...images.map((i) => i.data)]))
mkdirSync('src/renderer/src/assets/brand', { recursive: true })
await sharp(source).resize(BRAND_SIZE, BRAND_SIZE, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(brand)
console.log(`已生成 ${target}（${SIZES.join('/')}）和 ${brand}`)
