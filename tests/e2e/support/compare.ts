import sharp from 'sharp'

// 两张截图的差异：任一通道差超过阈值的像素占比，并输出一张差异图（差异处标红，其余淡化）。
// 高分屏缩放取整会让两边差一两个像素，只比较左上角的公共区域；差太多说明窗口尺寸不对，直接报错
export async function compareShots(a: string, b: string, diffOut: string, threshold = 24): Promise<number> {
  const [ma, mb] = await Promise.all([sharp(a).metadata(), sharp(b).metadata()])
  const width = Math.min(ma.width ?? 0, mb.width ?? 0)
  const height = Math.min(ma.height ?? 0, mb.height ?? 0)
  if (Math.abs((ma.width ?? 0) - (mb.width ?? 0)) > 3 || Math.abs((ma.height ?? 0) - (mb.height ?? 0)) > 3) {
    throw new Error(`截图尺寸相差太多：${ma.width}×${ma.height} 和 ${mb.width}×${mb.height}`)
  }
  const crop = { left: 0, top: 0, width, height }
  const [ia, ib] = await Promise.all([
    sharp(a).extract(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).extract(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  ])
  const out = Buffer.alloc(width * height * 4)
  let differ = 0
  for (let i = 0; i < width * height * 4; i += 4) {
    const d = Math.max(
      Math.abs(ia.data[i] - ib.data[i]),
      Math.abs(ia.data[i + 1] - ib.data[i + 1]),
      Math.abs(ia.data[i + 2] - ib.data[i + 2])
    )
    if (d > threshold) {
      differ++
      out.set([230, 30, 60, 255], i)
    } else {
      const g = Math.round((ia.data[i] + ia.data[i + 1] + ia.data[i + 2]) / 3)
      const faded = Math.round(255 - (255 - g) * 0.25)
      out.set([faded, faded, faded, 255], i)
    }
  }
  await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile(diffOut)
  return differ / (width * height)
}
