import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 日志级别，从低到高
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// 单个日志文件上限与保留份数：main.log 写满后依次滚动为 main.1.log … main.3.log
const MAX_BYTES = 5 * 1024 * 1024
const KEEP_FILES = 3

interface LoggerState {
  file: string | null
  level: LogLevel
  echo: boolean
}

const state: LoggerState = { file: null, level: 'info', echo: true }

// 初始化文件日志：开发模式默认 info 并同时输出到控制台，桌面快捷方式运行默认 warn；LTM_LOG_LEVEL 可覆盖
export function initLogger(logsDir: string, isDev: boolean, env: NodeJS.ProcessEnv): void {
  const fromEnv = env.LTM_LOG_LEVEL?.trim().toLowerCase()
  state.level = fromEnv && fromEnv in LEVEL_RANK ? (fromEnv as LogLevel) : isDev ? 'info' : 'warn'
  state.echo = isDev
  state.file = join(logsDir, 'main.log')
}

// 文件超过上限时滚动，最旧的一份丢弃
function rotateIfNeeded(file: string): void {
  if (!existsSync(file) || statSync(file).size < MAX_BYTES) {
    return
  }
  rmSync(`${file}.${KEEP_FILES}`, { force: true })
  for (let i = KEEP_FILES - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    }
  }
  renameSync(file, `${file}.1`)
}

// 把异常转成一行可读文本：只取类型、信息和调用栈，不展开任意对象，避免把入参写进日志
function describe(detail: unknown): string {
  if (detail instanceof Error) {
    return `${detail.name}: ${detail.message}${detail.stack ? `\n${detail.stack}` : ''}`
  }
  return String(detail)
}

// 写一条日志；写文件失败时只退回控制台，不影响业务
function write(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) {
    return
  }
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${
    detail === undefined ? '' : ` | ${describe(detail)}`
  }`
  if (state.echo || !state.file) {
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    out(line)
  }
  if (state.file) {
    try {
      rotateIfNeeded(state.file)
      appendFileSync(state.file, `${line}\n`, 'utf8')
    } catch (err) {
      console.error('[logger] 写日志文件失败:', err instanceof Error ? err.message : err)
    }
  }
}

// 按模块取日志器；不要记录密码、凭证、令牌或用户原始输入
export function getLogger(scope: string): {
  debug: (message: string, detail?: unknown) => void
  info: (message: string, detail?: unknown) => void
  warn: (message: string, detail?: unknown) => void
  error: (message: string, detail?: unknown) => void
} {
  return {
    debug: (message, detail) => write('debug', scope, message, detail),
    info: (message, detail) => write('info', scope, message, detail),
    warn: (message, detail) => write('warn', scope, message, detail),
    error: (message, detail) => write('error', scope, message, detail)
  }
}
