// 开发模式启动：把数据目录和类目录隔离到 D:\ltm-dev，绝不碰真实数据目录 %APPDATA%\LocalToolManage
import { spawn } from 'node:child_process'

const env = {
  ...process.env,
  LTM_DATA_DIR: process.env.LTM_DATA_DIR || 'D:\ltm-dev\data',
  LTM_CATEGORY_HOME: process.env.LTM_CATEGORY_HOME || 'D:\ltm-dev\library'
}

console.log(`[dev] 数据目录 ${env.LTM_DATA_DIR}，类目录 ${env.LTM_CATEGORY_HOME}`)
const child = spawn('npx', ['electron-vite', 'dev'], { env, stdio: 'inherit', shell: true })
child.on('exit', (code) => process.exit(code ?? 0))
