// 标签分类的 12 色调色板（照原型 PAL）：浅底、深字、描边、圆点。都是 palette.ts 里的变量，深色模式自动换
export interface TagColor {
  bg: string
  ink: string
  line: string
  dot: string
}

const PAL: Array<[string, string, string, string]> = [
  ['FCE7EE', 'A23D62', 'F2C6D4', 'D86F95'],
  ['EFEAFB', '4E3C99', 'D8CCEF', '7A63C9'],
  ['E2F4EE', '1F6B57', 'BFE3D6', '3F8F7B'],
  ['FCEEDC', '8A4E12', 'EED3B3', 'C98A3E'],
  ['DDEBFA', '1F5A8A', 'BBD5EE', '4A86C2'],
  ['DFF3F5', '17656E', 'B7E0E4', '2E9AA6'],
  ['F3E6F7', '7A3E8C', 'E0C6E8', 'A65BBE'],
  ['FBE9E4', '9A3B22', 'F1CBBF', 'D2694A'],
  ['FBF4D6', '7A6210', 'EEDFA3', 'C7A42B'],
  ['E8EEF3', '3E5366', 'CCD8E2', '6D879E'],
  ['EAF4DC', '4A6A1C', 'D2E6B6', '7FA83C'],
  ['F6E6EF', '8A2F5E', 'EBC8DA', 'B9568A']
]

// 按分类的颜色序号取一组颜色；序号越界时按 12 取余
export function tagColor(index: number): TagColor {
  const [bg, ink, line, dot] = PAL[((index % PAL.length) + PAL.length) % PAL.length]
  return { bg: `var(--c-b-${bg})`, ink: `var(--c-i-${ink})`, line: `var(--c-b-${line})`, dot: `var(--c-b-${dot})` }
}
