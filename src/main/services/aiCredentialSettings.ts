import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { safeStorage } from 'electron'
import { AI_CREDENTIAL_KEYS, type AiCredentialKey, type AiCredentialPatch, type AiCredentialStatus } from '@shared/settings'
import {
  CLOUD_ENV_NAMES,
  TOKEN_PLAN_ENV,
  isTokenPlanLocalMode,
  setWindowsUserHasTokenPlan,
  getSavedCloudCredentials,
  readEnvironmentCloudCredentials,
  setSavedCloudCredentials,
  setUserEnvironmentCloudCredentials,
  type CloudCredentials
} from '../config/cloudConfig'
import { BizError } from '../common/bizError'
import { getLogger } from '../common/logger'
import { changeLookBatchKey, onLookKeyChanged } from './ai/lookService'

const log = getLogger('settings')
const execFileAsync = promisify(execFile)
let credentialFile: string
let lastSave = Promise.resolve()

// 桌面进程可能早于用户变量启动。子进程只返回存在性，套餐密钥不进入应用数据。
async function loadTokenPlanMode(): Promise<void> {
  if (process.platform !== 'win32' || process.env[TOKEN_PLAN_ENV] !== undefined) return
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const check = `[int](![string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('${TOKEN_PLAN_ENV}','User')))`
    const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', check], { windowsHide: true, timeout: 8000 })
    const result = stdout.trim()
    setWindowsUserHasTokenPlan(result !== '0')
  } catch {
    setWindowsUserHasTokenPlan(true)
    log.warn('无法确认套餐配置，本次启动暂用本地模式')
  }
}

// 由旧的桌面进程启动时，进程环境可能还没有继承新设置的 Windows 用户变量。
async function loadWindowsUserEnvironment(): Promise<CloudCredentials> {
  const credentials: CloudCredentials = {}
  if (process.platform !== 'win32') return credentials
  const registryTool = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  await Promise.all(AI_CREDENTIAL_KEYS.map(async (key) => {
    const name = CLOUD_ENV_NAMES[key]
    if (process.env[name] !== undefined) return
    try {
      const { stdout } = await execFileAsync(registryTool, ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true, timeout: 1500 })
      const value = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ[ \\t]+(.+)$`, 'm').exec(stdout)?.[1].trim()
      if (value) credentials[key] = value
    } catch {
      // 未配置的用户变量会让 reg.exe 返回非零状态。
    }
  }))
  return credentials
}

function validatePatch(raw: unknown): AiCredentialPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BizError('BAD_REQUEST', 'AI 密钥格式不正确')
  }
  const patch: AiCredentialPatch = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(CLOUD_ENV_NAMES, key)) {
      throw new BizError('BAD_REQUEST', '存在未知的 AI 密钥字段')
    }
    const normalized = typeof value === 'string' ? value.trim() : value
    if (normalized !== null && (typeof normalized !== 'string' || !normalized || normalized.length > 4096 || /[\x00-\x20\x7f]/.test(normalized))) {
      throw new BizError('BAD_REQUEST', 'AI 密钥格式不正确')
    }
    patch[key as AiCredentialKey] = normalized
  }
  return patch
}

async function loadSavedCredentials(): Promise<void> {
  try {
    const encrypted = await readFile(credentialFile)
    const { result } = await safeStorage.decryptStringAsync(encrypted)
    const patch = validatePatch(JSON.parse(result))
    const credentials: CloudCredentials = {}
    for (const key of AI_CREDENTIAL_KEYS) {
      const value = patch[key]
      if (value) credentials[key] = value
    }
    setSavedCloudCredentials(credentials)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('无法读取已保存的 AI 密钥，使用环境变量')
    }
  }
}

export async function initAiCredentialSettings(dataRoot: string): Promise<void> {
  credentialFile = join(dataRoot, 'ai-credentials.enc')
  await Promise.all([loadSavedCredentials(), loadWindowsUserEnvironment().then(setUserEnvironmentCloudCredentials), loadTokenPlanMode()])
}

export function getAiCredentialStatus(): AiCredentialStatus {
  const saved = getSavedCloudCredentials()
  const env = readEnvironmentCloudCredentials()
  const status = {} as AiCredentialStatus
  for (const key of AI_CREDENTIAL_KEYS) {
    status[key] = saved[key] ? 'saved' : env[key] ? 'environment' : 'missing'
  }
  if (isTokenPlanLocalMode()) status.localOnly = true
  return status
}

async function writeCredentials(credentials: CloudCredentials): Promise<void> {
  if (Object.keys(credentials).length === 0) {
    await rm(credentialFile, { force: true })
    return
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable()) || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new BizError('DEPENDENCY_FAILED', '系统密钥存储不可用')
  }
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials))
  // 先写同目录的临时文件，再替换原文件，避免意外退出时破坏上一次保存。
  const tmp = `${credentialFile}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, encrypted, { flag: 'wx', mode: 0o600, flush: true })
    await rename(tmp, credentialFile)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

export async function saveAiCredentialSettings(raw: unknown): Promise<AiCredentialStatus> {
  const patch = validatePatch(raw)
  if (Object.keys(patch).length === 0) return getAiCredentialStatus()
  const save = lastSave.then(async () => {
    const saved = getSavedCloudCredentials()
    const credentials = { ...saved }
    for (const key of AI_CREDENTIAL_KEYS) {
      const value = patch[key]
      if (value === null) delete credentials[key]
      else if (value !== undefined) credentials[key] = value
    }
    const persist = async (): Promise<void> => {
      try {
        await writeCredentials(credentials)
      } catch (err) {
        if (err instanceof BizError) throw err
        throw new BizError('DEPENDENCY_FAILED', '无法保存 AI 密钥')
      }
      setSavedCloudCredentials(credentials)
    }
    const envKey = readEnvironmentCloudCredentials().dashscopeApiKey
    const currentKey = saved.dashscopeApiKey ?? envKey
    const keyChanged = !isTokenPlanLocalMode() && currentKey !== (credentials.dashscopeApiKey ?? envKey)
    if (currentKey && keyChanged) {
      await changeLookBatchKey(persist)
    } else {
      await persist()
    }
    if (keyChanged) await onLookKeyChanged()
  })
  lastSave = save.catch(() => undefined)
  await save
  return getAiCredentialStatus()
}

export function waitForAiCredentialSaves(): Promise<void> {
  return lastSave
}
