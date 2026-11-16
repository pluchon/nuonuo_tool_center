import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 单元测试跑在 Node 里（主进程逻辑和 PGlite），端到端测试用 Playwright 启动构建好的应用
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
})
