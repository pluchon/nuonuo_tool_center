import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BizError } from '../../src/main/common/bizError'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { PgWorkflow, getWorkflow, transitionWorkflow, upsertWorkflow } from '../../src/main/repositories/aiWorkflowRepository'
import { upsertSettings } from '../../src/main/repositories/appSettingRepository'
import { chatCall } from '../../src/main/services/ai/bailianClient'
import { dreamOnce, type DreamWorkflowState } from '../../src/main/services/ai/dreamService'
import * as organize from '../../src/main/services/ai/organizeService'

vi.mock('electron', () => ({ clipboard: {}, nativeImage: {}, shell: {} }))
vi.mock('../../src/main/services/ai/bailianClient', () => ({ chatCall: vi.fn() }))

const dir = mkdtempSync(join(tmpdir(), 'nono-pgworkflow-'))
const open = () => openDatabase(join(dir, 'db'), resolve('drizzle'))

beforeAll(async () => {
  await open()
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  const { pg } = getDatabase()
  await pg.exec('DELETE FROM ai_workflow; DELETE FROM app_setting; DELETE FROM ai_job; DELETE FROM ai_event; DELETE FROM ai_memory; DELETE FROM ai_profile;')
  vi.mocked(chatCall).mockReset()
})

describe('PgWorkflow 状态机与乐观锁', () => {
  it('upsertWorkflow 递增版本并在 expectedVersion 不匹配时抛出 CONFLICT', async () => {
    const v1 = await PgWorkflow.upsert('ORGANIZE', 'test-lock', {
      status: 'RUNNING',
      phase: 'LOOKING',
      state: { step: 1 }
    })
    expect(v1.version).toBe(1)

    const v2 = await upsertWorkflow('ORGANIZE', 'test-lock', {
      status: 'WAITING',
      phase: 'PLAN_READY',
      state: { step: 2 }
    }, v1.version)
    expect(v2.version).toBe(2)

    await expect(
      upsertWorkflow('ORGANIZE', 'test-lock', {
        status: 'IDLE',
        phase: 'IDLE',
        state: { step: 3 }
      }, v1.version)
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<BizError>)

    const latest = await getWorkflow<{ step: number }>('ORGANIZE', 'test-lock')
    expect(latest).toMatchObject({ version: 2, status: 'WAITING', phase: 'PLAN_READY', state: { step: 2 } })
  })

  it('transitionWorkflow 在事务内执行状态转移并在并发修改时触发乐观锁冲突', async () => {
    const created = await transitionWorkflow<{ count: number }>('TEST_FLOW', 'k1', (cur) => {
      expect(cur).toBeNull()
      return { status: 'RUNNING', phase: 'STEP_1', state: { count: 1 } }
    })
    expect(created).toMatchObject({ version: 1, phase: 'STEP_1', state: { count: 1 } })

    const unchanged = await transitionWorkflow<{ count: number }>('TEST_FLOW', 'k1', () => null)
    expect(unchanged?.version).toBe(1)

    await expect(
      transitionWorkflow<{ count: number }>('TEST_FLOW', 'k1', async (cur, tx) => {
        // 在同一事务内模拟预期版本已被推进，外层按旧 version 提交会冲突回滚
        await upsertWorkflow('TEST_FLOW', 'k1', {
          status: 'RUNNING',
          phase: 'STEP_INTERFERED',
          state: { count: 99 }
        }, cur!.version, tx)
        return { status: 'DONE', phase: 'STEP_2', state: { count: 2 } }
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // 事务回滚后仍保持原版本
    const persisted = await getWorkflow<{ count: number }>('TEST_FLOW', 'k1')
    expect(persisted).toMatchObject({ version: 1, phase: 'STEP_1', state: { count: 1 } })
  })
})

describe('Organize 与 Dream 的崩溃恢复和兼容性迁移', () => {
  it('restoreOrganize 自动将旧版 app_setting 状态迁移到 ai_workflow 并支持重启恢复', async () => {
    const legacyFrom = '2026-01-02T03:04:05.000Z'
    const legacyPlan = [{ name: '壁纸', isNew: true, characters: [], works: [], tags: ['风景'] }]
    await upsertSettings([
      { key: 'ai.organize', value: { phase: 'PLAN_READY', plan: legacyPlan, error: null } },
      { key: 'ai.organizeLookFrom', value: legacyFrom }
    ])

    const onState = vi.fn()
    organize.configureOrganize({ onState, onSuggested: () => undefined })
    await organize.restoreOrganize()

    expect(organize.getOrganizeState()).toEqual({ phase: 'PLAN_READY', plan: legacyPlan, error: null })
    expect(onState).toHaveBeenCalledWith({ phase: 'PLAN_READY', plan: legacyPlan, error: null })

    const migrated = await getWorkflow<{ plan: unknown; lookFrom: string | null }>('ORGANIZE', 'default')
    expect(migrated).toMatchObject({
      kind: 'ORGANIZE',
      key: 'default',
      status: 'WAITING',
      phase: 'PLAN_READY',
      version: 1,
      state: { plan: legacyPlan, lookFrom: legacyFrom }
    })

    // 模拟进程重启
    await closeDatabase()
    await open()
    await organize.restoreOrganize()
    expect(organize.getOrganizeState()).toEqual({ phase: 'PLAN_READY', plan: legacyPlan, error: null })
    await organize.cancelOrganize()
  })

  it('dreamService 兼容读取旧版游标与摘要配置，并把新游标与退避状态持久化到 ai_workflow', async () => {
    const { pg } = getDatabase()
    await pg.exec(`
      INSERT INTO ai_event (kind, payload) VALUES ('unrelated', '{}'), ('unrelated', '{}'), ('unrelated', '{}');
      INSERT INTO ai_job (kind, status, payload) VALUES ('DREAM', 'DONE', '{"lastEventId": 2}');
      INSERT INTO ai_memory (content, kind, confidence) VALUES ('喜欢简约构图', 'preference', 0.9);
    `)
    await upsertSettings([{ key: 'ai.dream.summary', value: { failed: 1, retryAt: 0 } }])

    vi.stubEnv('DASHSCOPE_API_KEY', 'fixture-dream-key')
    try {
      vi.mocked(chatCall).mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      await dreamOnce(true)

      const wf = await getWorkflow<DreamWorkflowState>('DREAM', 'default')
      expect(wf).not.toBeNull()
      expect(wf!.state.lastEventId).toBeGreaterThanOrEqual(3)
      expect(wf!.state.failed).toBe(2)
      expect(wf!.state.retryAt).toBeGreaterThan(Date.now())

      // 重启后退避时间依然生效，不会重复调模型
      await closeDatabase()
      await open()
      await dreamOnce(true)
      expect(chatCall).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
