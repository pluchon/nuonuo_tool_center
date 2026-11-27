import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AI_SETTING_KEYS } from '../../src/main/config/cloudConfig'
import { closeDatabase, getDatabase, openDatabase } from '../../src/main/db/client'
import { apiUsage } from '../../src/main/db/schema'
import { upsertSettings } from '../../src/main/repositories/appSettingRepository'
import { getAiUsageStats } from '../../src/main/services/ai/usageStatsService'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ltm-usage-stats-'))
  await openDatabase(join(dir, 'pgdata'), resolve('drizzle'))
})

beforeEach(async () => {
  await getDatabase().db.delete(apiUsage)
  await upsertSettings([{ key: AI_SETTING_KEYS.localHits, value: 0 }])
})

afterAll(async () => {
  await closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('getAiUsageStats', () => {
  it('空库返回当年完整日历热力、7/15/30/6月/1年序列与 5 轴零值雷达', async () => {
    const fixedNow = new Date(2026, 10, 26, 14, 0, 0)
    const stats = await getAiUsageStats(fixedNow)

    expect(stats.summary).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      imageTokens: 0,
      totalCalls: 0,
      successCalls: 0,
      errorCalls: 0,
      batchCalls: 0,
      searchCalls: 0,
      estCostYuan: 0,
      savedCostYuan: 0,
      cloudHitRate: 0,
      localHits: 0
    })
    expect(stats.availableYears).toEqual([2026])
    expect(stats.heatmap).toHaveLength(365)
    expect(stats.heatmap[0].date).toBe('2026-01-01')
    expect(stats.heatmap[364].date).toBe('2026-12-31')
    expect(stats.heatmapByYear[2026]).toHaveLength(365)
    expect(stats.series.d7).toHaveLength(7)
    expect(stats.series.d7[6]).toMatchObject({ key: '2026-11-26', label: '11/26', totalTokens: 0 })
    expect(stats.series.d15).toHaveLength(15)
    expect(stats.series.d30).toHaveLength(30)
    expect(stats.series.m6).toHaveLength(6)
    expect(stats.series.m12).toHaveLength(12)
    expect(stats.series.m12[0]).toMatchObject({ key: '2026-01', label: '1月' })
    expect(stats.series.m12[11]).toMatchObject({ key: '2026-12', label: '12月' })
    expect(stats.byKind).toEqual([])
    expect(stats.radar).toHaveLength(5)
    expect(stats.radar.every((axis) => axis.value === 0)).toBe(true)
  })

  it('精确核算实时、缓存、批量、联网搜索、向量与失败调用的费用、节省额与多维度聚合', async () => {
    const fixedNow = new Date(2026, 10, 26, 14, 0, 0)
    await upsertSettings([{ key: AI_SETTING_KEYS.localHits, value: 4 }])

    await getDatabase().db
      .insert(apiUsage)
      .values([
        // 1) 当天 look 批量 + 前缀缓存 + 联网搜索
        // fresh=500_000, cached=500_000 (0.2x -> 100_000), output=200_000
        // baseCost = (600_000*0.8 + 200_000*2.7)/1e6 = (0.48 + 0.54) = 1.02
        // batch 0.5x => 0.51, + search 1*0.004 => 0.514
        // fullCost = (1_000_000*0.8 + 200_000*2.7)/1e6 + 0.004 = 0.8 + 0.54 + 0.004 = 1.344
        // saved = 1.344 - 0.514 = 0.83
        {
          api: 'look',
          model: 'qwen3.8-flash',
          units: 1,
          estCost: '0',
          inputTokens: 1_000_000,
          cachedTokens: 500_000,
          cacheWriteTokens: 100_000,
          imageTokens: 300_000,
          outputTokens: 200_000,
          searchCount: 1,
          batch: true,
          latencyMs: 1200,
          error: null,
          createTime: new Date(2026, 10, 26, 10, 0, 0)
        },
        // 2) 当天 chat 实时调用（无缓存无批量）
        // cost = (500_000*0.8 + 100_000*2.7)/1e6 = 0.4 + 0.27 = 0.67
        {
          api: 'chat',
          model: 'qwen3.8-flash',
          units: 1,
          estCost: '0',
          inputTokens: 500_000,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          imageTokens: 0,
          outputTokens: 100_000,
          searchCount: 0,
          batch: false,
          latencyMs: 800,
          error: null,
          createTime: new Date(2026, 10, 26, 11, 0, 0)
        },
        // 3) 昨天 embed 调用，仅记录 units
        // cost = 1_000_000 * 0.7 / 1e6 = 0.7
        {
          api: 'embed',
          model: 'qwen3-vl-embedding',
          units: 1_000_000,
          estCost: '0',
          inputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          imageTokens: 0,
          outputTokens: 0,
          searchCount: 0,
          batch: false,
          latencyMs: 400,
          error: null,
          createTime: new Date(2026, 10, 25, 9, 0, 0)
        },
        // 4) 上个月失败调用（有纯 estCost 兜底）
        {
          api: 'look',
          model: 'qwen3.8-flash',
          units: 0,
          estCost: '0.01',
          inputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          imageTokens: 0,
          outputTokens: 0,
          searchCount: 0,
          batch: false,
          latencyMs: 3000,
          error: 'timeout',
          createTime: new Date(2026, 9, 15, 8, 0, 0)
        }
      ])

    const stats = await getAiUsageStats(fixedNow)

    expect(stats.summary.totalCalls).toBe(4)
    expect(stats.summary.successCalls).toBe(3)
    expect(stats.summary.errorCalls).toBe(1)
    expect(stats.summary.batchCalls).toBe(1)
    expect(stats.summary.searchCalls).toBe(1)
    expect(stats.summary.localHits).toBe(4)
    expect(stats.summary.inputTokens).toBe(2_500_000)
    expect(stats.summary.cachedTokens).toBe(500_000)
    expect(stats.summary.outputTokens).toBe(300_000)
    expect(stats.summary.totalTokens).toBe(2_800_000)
    expect(stats.summary.estCostYuan).toBeCloseTo(1.894, 6)
    expect(stats.summary.savedCostYuan).toBeCloseTo(0.83, 6)
    expect(stats.summary.cloudHitRate).toBeCloseTo(0.2, 6)

    const todayPoint = stats.heatmap.find((p) => p.date === '2026-11-26')
    expect(todayPoint).toMatchObject({
      date: '2026-11-26',
      totalTokens: 1_800_000,
      inputTokens: 1_500_000,
      cachedTokens: 500_000,
      outputTokens: 300_000,
      calls: 2
    })
    expect(todayPoint!.estCostYuan).toBeCloseTo(1.184, 6)
    expect(stats.series.d15).toHaveLength(15)
    expect(stats.series.m6).toHaveLength(6)

    expect(stats.series.d7[6]).toMatchObject({
      key: '2026-11-26',
      inputFreshTokens: 1_000_000,
      cachedTokens: 500_000,
      outputTokens: 300_000,
      calls: 2
    })
    expect(stats.series.m12[9]).toMatchObject({
      key: '2026-10',
      label: '10月',
      calls: 1,
      estCostYuan: 0.01
    })

    expect(stats.byKind.map((row) => row.api)).toEqual(['look', 'embed', 'chat'])
    expect(stats.byKind[0]).toMatchObject({
      api: 'look',
      label: '诺诺看图',
      calls: 2,
      avgLatencyMs: 2100,
      errorCalls: 1
    })

    const radarMap = Object.fromEntries(stats.radar.map((axis) => [axis.key, axis.value]))
    expect(radarMap.cacheHit).toBe(20)
    expect(radarMap.localHit).toBe(50) // 4 / (4 + 4) = 50%
    expect(radarMap.batchRatio).toBe(25) // 1 / 4 = 25%
    expect(radarMap.successRate).toBe(75) // 3 / 4 = 75%
    expect(radarMap.costSaved).toBeCloseTo((0.83 / (1.894 + 0.83)) * 100, 1)
  })

  it('按模型单价区分 deepseek-v4.1-flash-1017 与 qwen3.8-flash 费用估算', async () => {
    const fixedNow = new Date(2026, 10, 27, 10, 0, 0)
    await getDatabase().db.insert(apiUsage).values([
      // fresh=500_000, cached=500_000 (0.2x -> 100_000), output=100_000
      // cost = (600_000 * 0.283 + 100_000 * 1.131) / 1e6 = 0.1698 + 0.1131 = 0.2829
      {
        api: 'chat',
        model: 'deepseek-v4.1-flash-1017',
        units: 1,
        estCost: '0',
        inputTokens: 1_000_000,
        cachedTokens: 500_000,
        cacheWriteTokens: 0,
        imageTokens: 0,
        outputTokens: 100_000,
        searchCount: 0,
        batch: false,
        latencyMs: 500,
        error: null,
        createTime: new Date(2026, 10, 27, 9, 0, 0)
      }
    ])
    const stats = await getAiUsageStats(fixedNow)
    const chatRow = stats.byKind.find((row) => row.api === 'chat')!
    expect(chatRow.estCostYuan).toBeCloseTo(0.2829, 6)
  })
})
