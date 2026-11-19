// 主题背景：移植自 Claude Code 官方 theme-examples 插件（Apache-2.0），浅色窗口用 Halftone Dawn / Plotter Tide / Paper Garden，
// 深色窗口用 Halftone Dusk / Plotter Tide Night / Paper Garden Kraft。背景自带动画（网点呼吸、线条画出、叶子摇摆），
// 系统开了“减少动画”时 SVG 里自己停下。面板玻璃换成各自纸张的颜色，面板和背景是一套
import halftoneDark from '@/assets/scenes/halftone-dark.svg?url'
import halftoneLight from '@/assets/scenes/halftone-light.svg?url'
import paperDark from '@/assets/scenes/paper-dark.svg?url'
import paperLight from '@/assets/scenes/paper-light.svg?url'
import plotterDark from '@/assets/scenes/plotter-dark.svg?url'
import plotterLight from '@/assets/scenes/plotter-light.svg?url'

export type SceneKey = 'halftone' | 'plotter' | 'paper'

// 一张主题背景：图、纸色、玻璃色（RGB）
export interface Scene {
  url: string
  paper: string
  glass: readonly [number, number, number]
}

const SCENES: Record<SceneKey, { light: Scene; dark: Scene }> = {
  halftone: {
    light: { url: halftoneLight, paper: '#f6ecdc', glass: [246, 234, 217] },
    dark: { url: halftoneDark, paper: '#1b1f30', glass: [31, 35, 54] }
  },
  plotter: {
    light: { url: plotterLight, paper: '#f4efe4', glass: [244, 239, 228] },
    dark: { url: plotterDark, paper: '#141a27', glass: [20, 26, 39] }
  },
  paper: {
    light: { url: paperLight, paper: '#f8f3e9', glass: [251, 246, 236] },
    dark: { url: paperDark, paper: '#24211d', glass: [53, 49, 42] }
  }
}

export function sceneOf(key: SceneKey, isDark: boolean): Scene {
  return SCENES[key][isDark ? 'dark' : 'light']
}
