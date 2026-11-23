import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 单元测试跑在 Node 里（主进程逻辑和 PGlite），端到端测试用 Playwright 启动构建好的应用
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    // 测试只使用用例提供的模拟凭证，避免继承开发机的付费账户。
    env: {
      ALIYUN_TOKEN_PLAN_KEY: ' ',
      DASHSCOPE_API_KEY: ' ',
      ALIYUN_ACCESS_KEY_ID: ' ',
      ALIYUN_ACCESS_KEY_SECRET: ' '
    },
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
})
