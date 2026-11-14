import { defineConfig } from 'drizzle-kit'

// 只用于生成迁移 SQL；运行时迁移由主进程在启动时执行
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/main/db/schema.ts',
  out: './drizzle'
})
