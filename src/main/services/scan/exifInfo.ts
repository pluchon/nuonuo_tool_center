import exifReader from 'exif-reader'
import type { ExifInfoVO } from '@shared/api'

// 存进 image.exif 的拍摄信息：和详情面板共用一个结构（焦距毫米、光圈 f 值、快门秒）
export type ExifInfo = ExifInfoVO

// 解析结果：拍摄信息（一项都没有时为空）和拍摄时间
export interface ParsedExif {
  info: ExifInfo | null
  takenAt: Date | null
}

const EMPTY: ParsedExif = { info: null, takenAt: null }

// 去掉首尾空白和结尾的 \0，空串当没有
function cleanText(v: unknown): string | undefined {
  if (typeof v !== 'string') {
    return undefined
  }
  const s = v.replace(/\0+$/, '').trim()
  return s || undefined
}

// 只接受有限正数
function positive(v: unknown): number | undefined {
  const n = Array.isArray(v) ? v[0] : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined
}

// EXIF 时间没有时区：exif-reader 把墙上时间按 UTC 解析，这里按本机时区还原成同样的墙上时间
function wallClock(v: unknown): Date | null {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) {
    return null
  }
  const d = new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds())
  // 相机没设时间时常写成 0000:00:00 或 1970 年附近，当没有
  return d.getFullYear() < 1980 ? null : d
}

// 解析 EXIF：缓冲区以 “Exif\0\0” 或 TIFF 头（II*\0 / MM\0*）开头；格式不认识或损坏时返回空，不抛错
export function parseExif(buffer: Buffer | undefined | null): ParsedExif {
  if (!buffer || buffer.length < 8) {
    return EMPTY
  }
  let raw: ReturnType<typeof exifReader>
  try {
    raw = exifReader(buffer)
  } catch {
    return EMPTY
  }
  const img = raw.Image ?? {}
  const photo = raw.Photo ?? {}
  const all: ExifInfo = {
    make: cleanText(img.Make),
    model: cleanText(img.Model),
    lens: cleanText(photo.LensModel),
    focalLength: positive(photo.FocalLength),
    fNumber: positive(photo.FNumber),
    exposureTime: positive(photo.ExposureTime),
    iso: positive(photo.ISOSpeedRatings) ?? positive(photo.PhotographicSensitivity)
  }
  // 没有的项不写进 JSON
  const info = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as ExifInfo
  const takenAt = wallClock(photo.DateTimeOriginal) ?? wallClock(photo.DateTimeDigitized)
  return { info: Object.keys(info).length > 0 ? info : null, takenAt }
}
