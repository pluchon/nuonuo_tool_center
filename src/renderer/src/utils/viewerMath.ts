import type { ScanFormat } from '@shared/settings'

// 缩放范围（相对“适应窗口”的百分比），按钮一次 25，Ctrl + 滚轮一次 10
export const ZOOM_MIN = 25
export const ZOOM_MAX = 400
export const ZOOM_STEP = 25
export const WHEEL_STEP = 10

// 浏览器能直接显示的格式；HEIC、RAW 只能看缩略图
const BROWSER_FORMATS: readonly ScanFormat[] = ['JPG', 'PNG', 'GIF', 'WEBP', 'BMP', 'AVIF']

export function canShowOriginal(format: ScanFormat): boolean {
  return BROWSER_FORMATS.includes(format)
}

// 旋转了 90° 或 270° 时宽高对调
export function isSideways(rot: number): boolean {
  return Math.abs(Math.round(rot / 90)) % 2 === 1
}

// “适应窗口”（100%）时原图要缩成多少倍：整张都放得下，小图不放大
export function fitScale(natW: number, natH: number, stageW: number, stageH: number, rot: number): number {
  if (natW <= 0 || natH <= 0 || stageW <= 0 || stageH <= 0) {
    return 1
  }
  const [w, h] = isSideways(rot) ? [natH, natW] : [natW, natH]
  return Math.min(1, stageW / w, stageH / h)
}

// “原始大小”对应的缩放百分比（一个原图像素对一个屏幕像素）
export function actualZoom(fit: number): number {
  return Math.round(100 / fit)
}

// 缩放上限：平时 400%，原始大小超过 400% 的大图放宽到原始大小
export function zoomCeil(fit: number): number {
  return Math.max(ZOOM_MAX, actualZoom(fit))
}

// 把缩放限制在范围内
export function clampZoom(z: number, fit: number): number {
  return Math.max(ZOOM_MIN, Math.min(zoomCeil(fit), Math.round(z)))
}
