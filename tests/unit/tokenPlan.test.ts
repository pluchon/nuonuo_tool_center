import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSavedCloudCredentials, isTokenPlanLocalMode, readCloudCredentials, setSavedCloudCredentials, setWindowsUserHasTokenPlan } from '../../src/main/config/cloudConfig'
import { getBailianClient } from '../../src/main/services/ai/bailianClient'
import { embed } from '../../src/main/services/ai/embeddingClient'
import { getAiStatus, ask } from '../../src/main/services/ai/assistantService'
import { initLook, lookNow, retryLook } from '../../src/main/services/ai/lookService'
import { startOrganize } from '../../src/main/services/ai/organizeService'
import { getAiCredentialStatus } from '../../src/main/services/aiCredentialSettings'

vi.mock('electron', () => ({ clipboard: {}, nativeImage: {}, shell: {}, safeStorage: {} }))

describe('套餐本地模式', () => {
  afterEach(() => {
    setSavedCloudCredentials({})
    setWindowsUserHasTokenPlan(false)
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('进程和 Windows 用户变量均可启用，只暴露状态，普通密钥和 OSS 配置仍保留', () => {
    vi.stubEnv('ALIYUN_TOKEN_PLAN_KEY', undefined)
    vi.stubEnv('DASHSCOPE_API_KEY', 'environment-fake')
    setSavedCloudCredentials({ dashscopeApiKey: 'saved-fake', aliyunAccessKeyId: 'oss-id', aliyunAccessKeySecret: 'oss-secret' })
    expect(readCloudCredentials().dashscopeApiKey).toBe('saved-fake')
    getBailianClient()
    setWindowsUserHasTokenPlan(true)
    expect(isTokenPlanLocalMode()).toBe(true)
    expect(getAiStatus()).toEqual({ ready: false, localOnly: true })
    expect(getAiCredentialStatus()).toMatchObject({ dashscopeApiKey: 'saved', localOnly: true })
    expect(readCloudCredentials()).toEqual({ aliyunAccessKeyId: 'oss-id', aliyunAccessKeySecret: 'oss-secret' })
    expect(getBailianClient).toThrow('套餐本地模式')
    vi.stubEnv('ALIYUN_TOKEN_PLAN_KEY', ' ')
    expect(isTokenPlanLocalMode()).toBe(false)
    expect(readCloudCredentials().dashscopeApiKey).toBe('saved-fake')
    setWindowsUserHasTokenPlan(false)
    vi.stubEnv('ALIYUN_TOKEN_PLAN_KEY', 'fake-package-key')
    expect(isTokenPlanLocalMode()).toBe(true)
    expect(JSON.stringify([getSavedCloudCredentials(), getAiCredentialStatus(), getAiStatus()])).not.toContain('fake-package-key')
  })

  it('付费客户端、上传附件、嵌入与看图入口均在网络请求前停止', async () => {
    vi.stubEnv('ALIYUN_TOKEN_PLAN_KEY', 'fake-package-key')
    vi.stubEnv('DASHSCOPE_API_KEY', 'environment-fake')
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    expect(getBailianClient).toThrow('套餐本地模式')
    await expect(embed({ text: '蓝发' })).rejects.toThrow('套餐本地模式')
    await expect(startOrganize()).rejects.toThrow('套餐本地模式')
    await expect(lookNow(1)).rejects.toThrow('套餐本地模式')
    await expect(retryLook(1)).rejects.toThrow('套餐本地模式')
    await initLook()
    await expect(ask({ conversationId: null, text: '', includeR18: false, scope: null,
      attachments: [{ kind: 'markdown', name: 'prompt.md', text: '看图' }] })).rejects.toThrow('套餐本地模式')
    expect(network).not.toHaveBeenCalled()
  })
})
