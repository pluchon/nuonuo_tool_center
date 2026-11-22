// 配色：移植自原型 renderVals() 里的 av（主题色派生色）和 C（写死颜色在深色模式下的对应色）
// 用法：样式里写 var(--a-ink)、var(--c-i-3B3047)、var(--c-b-F4F0FA) 等，换主题色或深浅时整窗一起变

// 主题色派生出的一组颜色：深字、浅底、线条……深色模式下往深底上混
function accentVars(accent: string, isDark: boolean): Record<string, string> {
  const n = parseInt(accent.slice(1, 7), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const base = isDark ? [30, 26, 40] : [255, 255, 255]
  const hex = (c: number[]): string =>
    '#' +
    c
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  const mix = (t: number): string => hex(rgb.map((v, i) => base[i] + (v - base[i]) * t))
  const rgba = (a: number): string => `rgba(${rgb.join(', ')}, ${a})`
  const ink = isDark ? hex(rgb.map((v) => 255 - (255 - v) * 0.45)) : hex(rgb.map((v) => v * 0.64))
  const k = isDark
    ? { soft: 0.22, line: 0.42, line2: 0.26, mid: 0.55, bg: 0.1, a06: 0.1, a08: 0.14, a1: 0.16, a12: 0.2, a14: 0.22 }
    : { soft: 0.12, line: 0.28, line2: 0.15, mid: 0.4, bg: 0.05, a06: 0.06, a08: 0.08, a1: 0.1, a12: 0.12, a14: 0.14 }
  return {
    '--a': accent,
    '--a-ink': ink,
    '--a-soft': mix(k.soft),
    '--a-line': mix(k.line),
    '--a-line2': mix(k.line2),
    '--a-mid': mix(k.mid),
    '--a-bg': mix(k.bg),
    '--a06': rgba(k.a06),
    '--a08': rgba(k.a08),
    '--a1': rgba(k.a1),
    '--a12': rgba(k.a12),
    '--a14': rgba(k.a14)
  }
}

// 原型里写死的底色和线条（b_），以及文字和图标色（i_）
const B_COLORS =
  '2E9AA6 3F8F7B 4A86C2 6D879E 6E6280 7A63C9 7FA83C 86CDB8 9C90B3 A23D62 A65BBE B7E0E4 B8456E B8732E B9568A BBD5EE BFE3D6 C2335A C25B85 C7A42B C98A3E C9A9D9 CCD8E2 D2694A D2E6B6 D86F95 D8CCEF DDEBFA DFF3F5 E0577F E0C6E8 E2DAF0 E2F4EE E8964A E8A9BC E8EEF3 EAF4DC EBC8DA EED3B3 EEDFA3 EEE8F7 EFEAFB F1CBBF F1ECF8 F1EEF6 F2C6D4 F3E6F7 F3EFFB F4F0FA F4F1F8 F6CDD8 F6E6EF F8E3EA FBE9E4 FBF4D6 FBF9FE FCE7EE FCEEDC FCEFF3 FDF3E7'.split(
    ' '
  )
const I_COLORS =
  '17656E 1F5A8A 1F6B57 2E2440 2F7463 3B3047 3E5366 3F8F7B 4A6A1C 4A86C2 4E3C99 5E5270 6E6280 7A3E8C 7A6210 7F7494 8A2F5E 8A4E12 8A5A22 8A7F99 8A7FA0 8FB8AA 9A3B22 9C90B3 A23D62 B07A93 B8732E B9AFC9 C25B85 CDBEFF FFB3C7'.split(
    ' '
  )
// 手工指定的深色对应色
const NIGHT_B: Record<string, string> = {
  FFFFFF: '#2A2536',
  F4F0FA: '#1F1B29',
  FBF9FE: '#262131',
  F3EFFB: '#282334',
  FAF8FD: '#2B2537',
  ECE6F7: '#332C40',
  EEE8F7: '#3A3348',
  F1ECF8: '#3A3348',
  F4F1F8: '#2A2536',
  F1EEF6: '#2A2536'
}
const NIGHT_I: Record<string, string> = {
  '3B3047': '#E8E3F0',
  '2E2440': '#F6F2FB',
  '6E6280': '#B6ACC6',
  '7F7494': '#A89EBA',
  '8A7FA0': '#A89EBA',
  '8A7F99': '#A89EBA',
  '9C90B3': '#8E84A0',
  B9AFC9: '#70677F',
  '5E5270': '#C6BDD4'
}

function toHsl(h: string): [number, number, number] {
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  if (!d) {
    return [0, 0, l]
  }
  const sat = d / (1 - Math.abs(2 * l - 1))
  const hue = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [hue * 60, sat, l]
}

function toHex(hh: number, ss: number, ll: number): string {
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = ll - c / 2
  const [r, g, b] =
    hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x]
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

// 底色和线条：浅底变成同色相的深底
function darkBase(h: string): string {
  if (NIGHT_B[h]) {
    return NIGHT_B[h]
  }
  const [hh, ss, ll] = toHsl(h)
  if (ll > 0.88) {
    return toHex(hh, Math.min(ss, 0.42), 0.2)
  }
  if (ll > 0.74) {
    return toHex(hh, Math.min(ss, 0.4), 0.32)
  }
  return '#' + h
}

// 文字和图标：深字变成同色相的浅字
function darkInk(h: string): string {
  if (NIGHT_I[h]) {
    return NIGHT_I[h]
  }
  const [hh, ss, ll] = toHsl(h)
  if (ll < 0.58) {
    return toHex(hh, Math.min(ss, 0.62), 0.8)
  }
  return '#' + h
}

// 写死颜色的变量，以及根节点上的玻璃、阴影、骨架屏、删除悬停等变量
function fixedVars(isDark: boolean): Record<string, string> {
  const out: Record<string, string> = {
    '--c-surface': isDark ? '#2A2536' : '#FFFFFF',
    '--w': isDark ? '38, 33, 50' : '255, 255, 255',
    '--sh': isDark ? '0, 0, 0' : '74, 58, 110',
    '--shim1': isDark ? '#2E2839' : '#ECE6F7',
    '--shim2': isDark ? '#3A3348' : '#FAF8FD',
    '--del-bg': isDark ? '#4A2233' : '#FCE7EE',
    '--del-ink': isDark ? '#F2A7C0' : '#A23D62',
    '--del-line': isDark ? '#6B3048' : '#F2C6D4'
  }
  for (const h of B_COLORS) {
    out[`--c-b-${h}`] = isDark ? darkBase(h) : '#' + h
  }
  for (const h of I_COLORS) {
    out[`--c-i-${h}`] = isDark ? darkInk(h) : '#' + h
  }
  return out
}

// 主题色加透明度
function tint(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

// 主题色往白里混
function whiteMix(hex: string, t: number): string {
  const n = parseInt(hex.slice(1, 7), 16)
  const ch = (v: number): number => Math.round(255 - (255 - v) * t)
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`
}

// 默认背景：只用主题色，接近白的一层淡染、左上角稍亮；深色是深紫黑加一团主题色柔光
export function defaultBackground(accent: string, isDark: boolean): string {
  return isDark
    ? `radial-gradient(70% 60% at 0% 0%, ${tint(accent, 0.2)} 0, ${tint(accent, 0)} 75%), linear-gradient(180deg, #1C1926 0%, #15121D 100%)`
    : `radial-gradient(70% 60% at 0% 0%, ${tint(accent, 0.1)} 0, ${tint(accent, 0)} 75%), linear-gradient(180deg, ${whiteMix(accent, 0.05)} 0%, ${whiteMix(accent, 0.1)} 100%)`
}

// 玻璃面板相关的设置：组件透明度（0–80）、磨砂玻璃开关、模糊程度
export interface GlassLook {
  panelClarity: number
  glass: boolean
  glassBlur: number
}

// 窗口背景：默认（主题色淡染），或一张图（主题背景、自定义图片）加淡化；glass 是面板玻璃的颜色（主题背景用它的纸色）
export type Backdrop =
  | { kind: 'none' }
  | { kind: 'image'; layers: string; glass: readonly [number, number, number] | null; dim: number }

// 原型 look：侧栏卡片、详情面板、底栏等的玻璃底色、模糊、描边和投影；有背景图时玻璃用背景的纸色、描边换成白边
function lookVars(accent: string, isDark: boolean, look: GlassLook, backdrop: Backdrop): Record<string, string> {
  const sceneGlass = backdrop.kind === 'image' ? backdrop.glass : null
  const glassRgb = sceneGlass ? sceneGlass.join(', ') : isDark ? '36, 31, 48' : '255, 255, 255'
  const hasBg = backdrop.kind === 'image'
  const glassOf = (a: number): string => `rgba(${glassRgb}, ${a.toFixed(2)})`
  const clr = look.panelClarity / 100
  const paneA = Math.max(0.06, 1 - clr * 1.15)
  const fieldA = Math.max(0.3, 1 - clr * 0.85)
  const blur = look.glass ? `blur(${look.glassBlur}px) saturate(1.5)` : 'none'
  return {
    '--look-pane-bg': glassOf(paneA),
    '--look-card-bg': glassOf(paneA),
    '--look-field-bg': `rgba(var(--w), ${fieldA.toFixed(2)})`,
    // 悬停、输入时稍微变实一点
    '--look-field-hover-bg': `rgba(var(--w), ${Math.min(1, fieldA + 0.32).toFixed(2)})`,
    '--look-foot-bg': glassOf(paneA * 0.7),
    '--look-blur': blur,
    '--look-edge': hasBg ? 'rgba(var(--w), 0.8)' : tint(accent, 0.16),
    '--look-rule': hasBg ? 'rgba(var(--w), 0.75)' : tint(accent, 0.16),
    // 设置弹窗本身的底：不跟“组件透明度”走，调透明度时设置页始终看得清
    '--look-dlg-bg': isDark ? 'rgba(34, 30, 44, 0.97)' : 'rgba(250, 248, 255, 0.97)',
    '--look-shadow': `0 12px 30px -24px ${tint(accent, 0.45)}, 0 1px 0 rgba(var(--w), 0.9) inset`,
    '--look-active-bg': `linear-gradient(90deg, ${accent}26, ${accent}08)`,
    // 数量胶囊、月份标题的星星和虚线
    '--look-chip-bg': tint(accent, 0.1),
    '--look-star': tint(accent, 0.55),
    '--look-dash': tint(accent, 0.28),
    // 缩略图卡片的磨砂底：透明度跟着“组件透明度”走，但保证名字看得清
    '--look-tile-bg': `rgba(var(--w), ${Math.max(0.12, 0.8 - clr * 0.85).toFixed(2)})`
  }
}

// 整窗背景：图上盖一层同纸色的淡化
function rootBackground(accent: string, isDark: boolean, backdrop: Backdrop): string {
  if (backdrop.kind === 'none') {
    return defaultBackground(accent, isDark)
  }
  const rgb = (backdrop.glass ?? (isDark ? [36, 31, 48] : [255, 255, 255])).join(', ')
  const a = (backdrop.dim / 100).toFixed(2)
  return `linear-gradient(rgba(${rgb}, ${a}), rgba(${rgb}, ${a})), ${backdrop.layers}`
}

// 一套完整的主题变量：设到根节点上即可
export function themeVars(accent: string, isDark: boolean, look: GlassLook, backdrop: Backdrop = { kind: 'none' }): Record<string, string> {
  return {
    ...accentVars(accent, isDark),
    ...fixedVars(isDark),
    ...lookVars(accent, isDark, look, backdrop),
    '--look-root-bg': rootBackground(accent, isDark, backdrop),
    '--look-brand-line': tint(accent, 0.55),
    'color-scheme': isDark ? 'dark' : 'light'
  }
}
