import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// 主进程依赖全部外部化（原生模块、wasm 资源按 node_modules 原路径加载）；preload 必须输出 CJS 才能在 sandbox 下运行
export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    // 本机 localhost 会被 Vite 解析成 ::1，而 Electron 按 127.0.0.1 去连，开发模式会白屏；固定监听 IPv4
    server: { host: '127.0.0.1' },
    plugins: [vue()]
  }
})
