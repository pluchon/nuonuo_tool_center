import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { setSavedCloudCredentials } from '../../src/main/config/cloudConfig'
import { getAiCredentialStatus, initAiCredentialSettings } from '../../src/main/services/aiCredentialSettings'
import { getAiStatus } from '../../src/main/services/ai/assistantService'
import { getBailianClient } from '../../src/main/services/ai/bailianClient'

let fakeDecryptPayload = '{}'
vi.mock('electron', () => ({
  clipboard: {},
  nativeImage: {},
  shell: {},
  safeStorage: {
    decryptStringAsync: vi.fn(async () => ({ result: fakeDecryptPayload }))
  }
}))

afterEach(() => {
  setSavedCloudCredentials({})
  vi.unstubAllEnvs()
})

it('聊天优先使用设置里的百炼密钥，清空后恢复环境变量', () => {
  vi.stubEnv('DASHSCOPE_API_KEY', 'environment-fake')
  setSavedCloudCredentials({ dashscopeApiKey: 'saved-fake' })
  expect(getAiStatus()).toEqual({ ready: true })
  expect(getAiCredentialStatus().dashscopeApiKey).toBe('saved')
  expect(getBailianClient().apiKey).toBe('saved-fake')
  setSavedCloudCredentials({})
  expect(getAiCredentialStatus().dashscopeApiKey).toBe('environment')
  expect(getBailianClient().apiKey).toBe('environment-fake')
})

it('缺少普通密钥时停止调用，即使已创建过客户端', () => {
  vi.stubEnv('DASHSCOPE_API_KEY', 'temporary-fake')
  getBailianClient()
  vi.stubEnv('DASHSCOPE_API_KEY', ' ')
  expect(getAiStatus()).toEqual({ ready: false })
  expect(getBailianClient).toThrow('未配置百炼 API Key')
})

it('加载旧版包含 OSS AccessKey 的加密凭证时自动忽略废弃键并正常读取百炼密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ltm-cred-'))
  try {
    writeFileSync(join(dir, 'ai-credentials.enc'), Buffer.from('cipher'))
    fakeDecryptPayload = JSON.stringify({
      dashscopeApiKey: 'legacy-dashscope-ok',
      aliyunAccessKeyId: 'legacy-oss-id',
      aliyunAccessKeySecret: 'legacy-oss-secret'
    })
    await initAiCredentialSettings(dir)
    expect(getAiCredentialStatus().dashscopeApiKey).toBe('saved')
    expect(getBailianClient().apiKey).toBe('legacy-dashscope-ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
