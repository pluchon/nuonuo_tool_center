import { extname } from 'node:path'
import type { ScanFormat, SkipSmall } from '@shared/settings'

// 扩展名到扫描格式的对照（小写，不带点）
const EXT_FORMAT: Record<string, ScanFormat> = {
  jpg: 'JPG',
  jpeg: 'JPG',
  jfif: 'JPG',
  png: 'PNG',
  gif: 'GIF',
  webp: 'WEBP',
  bmp: 'BMP',
  avif: 'AVIF',
  heic: 'HEIC',
  heif: 'HEIC',
  arw: 'RAW',
  cr2: 'RAW',
  cr3: 'RAW',
  nef: 'RAW',
  dng: 'RAW',
  raf: 'RAW',
  orf: 'RAW',
  rw2: 'RAW'
}

// 跳过小图的阈值（字节）
const SKIP_SMALL_BYTES: Record<SkipSmall, number> = { none: 0, '10': 10 * 1024, '50': 50 * 1024 }

// 按扩展名判断是不是图片文件，是则返回格式
export function formatOfFile(fileName: string): ScanFormat | null {
  return EXT_FORMAT[extname(fileName).slice(1).toLowerCase()] ?? null
}

// 按设置判断这个文件要不要处理：格式在勾选范围内，且不小于“跳过小图”的阈值
export function shouldProcess(format: ScanFormat, size: number, formats: readonly ScanFormat[], skipSmall: SkipSmall): boolean {
  return formats.includes(format) && size >= SKIP_SMALL_BYTES[skipSmall]
}
