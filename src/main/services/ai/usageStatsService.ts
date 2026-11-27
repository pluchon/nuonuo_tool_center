import {
  API_KIND_META,
  type AiUsageDailyPoint,
  type AiUsageKindRow,
  type AiUsageRadarAxis,
  type AiUsageSeriesPoint,
  type AiUsageStatsVO,
  type ApiKind
} from '../../../shared/api'
import { AI_SETTING_KEYS, DEEPSEEK_FLASH_PRICING, MODEL_PRICING } from '../../config/cloudConfig'

function chatRatesForModel(model: string | null | undefined): {
  inputPerMillionYuan: number
  outputPerMillionYuan: number
  cachedInputDiscount: number
} {
  if (/^deepseek-v4\.1-flash/i.test(model ?? '')) {
    return DEEPSEEK_FLASH_PRICING
  }
  return {
    inputPerMillionYuan: MODEL_PRICING.chatInputPerMillionYuan,
    outputPerMillionYuan: MODEL_PRICING.chatOutputPerMillionYuan,
    cachedInputDiscount: MODEL_PRICING.cachedInputDiscount
  }
}
import { findAllActiveApiUsage, type ActiveApiUsageRow } from '../../repositories/apiUsageRepository'
import { readSetting } from '../../repositories/appSettingRepository'

const ONE_MILLION = 1_000_000

const pad2 = (n: number): string => String(n).padStart(2, '0')

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function localMonthKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

function roundYuan(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function roundPct1(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

interface RowMetrics {
  api: ApiKind
  inputTokens: number
  freshInputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  imageTokens: number
  outputTokens: number
  totalTokens: number
  searchCount: number
  actualCost: number
  savedCost: number
  isError: boolean
  batch: boolean
  latencyMs: number
  dateKey: string
  monthKey: string
}

function evaluateRow(row: ActiveApiUsageRow): RowMetrics {
  const api = (row.api in API_KIND_META ? row.api : 'chat') as ApiKind
  const isEmbed = api === 'embed'
  const rawInput = Math.max(0, row.inputTokens)
  const rawOutput = Math.max(0, row.outputTokens)
  const rawCached = Math.max(0, row.cachedTokens)
  const searchCount = Math.max(0, row.searchCount)
  const parsedEstCost = Number(row.estCost ?? 0)
  const fallbackEstCost = Number.isFinite(parsedEstCost) && parsedEstCost > 0 ? parsedEstCost : 0

  let inputTokens = rawInput
  let cachedTokens = isEmbed ? 0 : Math.min(rawInput, rawCached)
  let freshInputTokens = Math.max(0, inputTokens - cachedTokens)
  let outputTokens = isEmbed ? 0 : rawOutput
  let totalTokens = inputTokens + outputTokens

  let actualCost = 0
  let savedCost = 0

  if (isEmbed) {
    const embedTokens = rawInput > 0 ? rawInput : Math.max(0, row.units)
    inputTokens = embedTokens
    freshInputTokens = embedTokens
    cachedTokens = 0
    totalTokens = embedTokens
    if (embedTokens > 0) {
      actualCost = (embedTokens * MODEL_PRICING.embedInputPerMillionYuan) / ONE_MILLION
    } else if (fallbackEstCost > 0) {
      actualCost = fallbackEstCost
    }
  } else {
    const hasActivity = rawInput > 0 || rawOutput > 0 || row.units > 0 || searchCount > 0
    if (!hasActivity && fallbackEstCost > 0) {
      actualCost = fallbackEstCost
    } else {
      const rates = chatRatesForModel(row.model)
      const discount = row.batch ? MODEL_PRICING.batchDiscount : 1
      const discountedInput = freshInputTokens + cachedTokens * rates.cachedInputDiscount
      const tokenCost =
        (discountedInput * rates.inputPerMillionYuan + outputTokens * rates.outputPerMillionYuan) / ONE_MILLION
      const searchCost = searchCount * MODEL_PRICING.webSearchPerCallYuan
      actualCost = tokenCost * discount + searchCost
      const fullCost =
        (inputTokens * rates.inputPerMillionYuan + outputTokens * rates.outputPerMillionYuan) / ONE_MILLION + searchCost
      savedCost = Math.max(0, fullCost - actualCost)
    }
  }

  const created = row.createTime instanceof Date ? row.createTime : new Date(row.createTime)
  return {
    api,
    inputTokens,
    freshInputTokens,
    cachedTokens,
    cacheWriteTokens: Math.max(0, row.cacheWriteTokens),
    imageTokens: Math.max(0, row.imageTokens),
    outputTokens,
    totalTokens,
    searchCount,
    actualCost,
    savedCost,
    isError: Boolean(row.error),
    batch: Boolean(row.batch),
    latencyMs: Math.max(0, row.latencyMs ?? 0),
    dateKey: localDateKey(created),
    monthKey: localMonthKey(created)
  }
}

export async function getAiUsageStats(now = new Date()): Promise<AiUsageStatsVO> {
  const [rows, localHitsSetting] = await Promise.all([
    findAllActiveApiUsage(),
    readSetting<number>(AI_SETTING_KEYS.localHits)
  ])

  const localHits = Math.max(0, localHitsSetting ?? 0)
  const dayBuckets = new Map<
    string,
    { inputTokens: number; freshInputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; calls: number; estCostYuan: number }
  >()
  const monthBuckets = new Map<
    string,
    { inputFreshTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; calls: number; estCostYuan: number }
  >()
  const kindBuckets = new Map<
    ApiKind,
    { calls: number; totalTokens: number; estCostYuan: number; latencySum: number; errorCalls: number }
  >()

  let totalTokens = 0
  let inputTokens = 0
  let cachedTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let imageTokens = 0
  let errorCalls = 0
  let batchCalls = 0
  let searchCalls = 0
  let estCostYuan = 0
  let savedCostYuan = 0

  const currentYear = now.getFullYear()
  const yearsSet = new Set<number>([currentYear])
  for (const raw of rows) {
    const m = evaluateRow(raw)
    const createdYear = Number(m.dateKey.slice(0, 4))
    if (Number.isInteger(createdYear) && createdYear > 1970) yearsSet.add(createdYear)
    totalTokens += m.totalTokens
    inputTokens += m.inputTokens
    cachedTokens += m.cachedTokens
    cacheWriteTokens += m.cacheWriteTokens
    outputTokens += m.outputTokens
    imageTokens += m.imageTokens
    if (m.isError) errorCalls += 1
    if (m.batch) batchCalls += 1
    searchCalls += m.searchCount
    estCostYuan += m.actualCost
    savedCostYuan += m.savedCost

    const day = dayBuckets.get(m.dateKey) ?? {
      inputTokens: 0,
      freshInputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
      estCostYuan: 0
    }
    day.inputTokens += m.inputTokens
    day.freshInputTokens += m.freshInputTokens
    day.cachedTokens += m.cachedTokens
    day.outputTokens += m.outputTokens
    day.totalTokens += m.totalTokens
    day.calls += 1
    day.estCostYuan += m.actualCost
    dayBuckets.set(m.dateKey, day)

    const month = monthBuckets.get(m.monthKey) ?? {
      inputFreshTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
      estCostYuan: 0
    }
    month.inputFreshTokens += m.freshInputTokens
    month.cachedTokens += m.cachedTokens
    month.outputTokens += m.outputTokens
    month.totalTokens += m.totalTokens
    month.calls += 1
    month.estCostYuan += m.actualCost
    monthBuckets.set(m.monthKey, month)

    const kind = kindBuckets.get(m.api) ?? {
      calls: 0,
      totalTokens: 0,
      estCostYuan: 0,
      latencySum: 0,
      errorCalls: 0
    }
    kind.calls += 1
    kind.totalTokens += m.totalTokens
    kind.estCostYuan += m.actualCost
    kind.latencySum += m.latencyMs
    if (m.isError) kind.errorCalls += 1
    kindBuckets.set(m.api, kind)
  }

  const totalCalls = rows.length
  const successCalls = totalCalls - errorCalls
  const roundedCost = roundYuan(estCostYuan)
  const roundedSaved = roundYuan(savedCostYuan)
  const cloudHitRate = inputTokens > 0 ? Math.min(1, cachedTokens / inputTokens) : 0

  const buildYearHeatmap = (year: number): AiUsageDailyPoint[] => {
    const out: AiUsageDailyPoint[] = []
    const cursor = new Date(year, 0, 1)
    const end = new Date(year, 11, 31)
    while (cursor <= end) {
      const date = localDateKey(cursor)
      const b = dayBuckets.get(date)
      out.push({
        date,
        totalTokens: b?.totalTokens ?? 0,
        inputTokens: b?.inputTokens ?? 0,
        cachedTokens: b?.cachedTokens ?? 0,
        outputTokens: b?.outputTokens ?? 0,
        calls: b?.calls ?? 0,
        estCostYuan: roundYuan(b?.estCostYuan ?? 0)
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    return out
  }

  const availableYears = [...yearsSet].sort((a, b) => b - a)
  const heatmapByYear: Record<number, AiUsageDailyPoint[]> = {}
  for (const yr of availableYears) {
    heatmapByYear[yr] = buildYearHeatmap(yr)
  }
  const heatmap = heatmapByYear[currentYear]

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const buildDaySeries = (days: number): AiUsageSeriesPoint[] => {
    const out: AiUsageSeriesPoint[] = []
    for (let offset = -(days - 1); offset <= 0; offset += 1) {
      const d = new Date(todayStart)
      d.setDate(todayStart.getDate() + offset)
      const key = localDateKey(d)
      const b = dayBuckets.get(key)
      out.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        inputFreshTokens: b?.freshInputTokens ?? 0,
        cachedTokens: b?.cachedTokens ?? 0,
        outputTokens: b?.outputTokens ?? 0,
        totalTokens: b?.totalTokens ?? 0,
        calls: b?.calls ?? 0,
        estCostYuan: roundYuan(b?.estCostYuan ?? 0)
      })
    }
    return out
  }

  const buildMonthSeries = (months: number): AiUsageSeriesPoint[] => {
    const out: AiUsageSeriesPoint[] = []
    for (let offset = -(months - 1); offset <= 0; offset += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
      const key = localMonthKey(d)
      const b = monthBuckets.get(key)
      const yy = String(d.getFullYear()).slice(-2)
      out.push({
        key,
        label: d.getMonth() === 0 ? `${yy}/01` : `${d.getMonth() + 1}月`,
        inputFreshTokens: b?.inputFreshTokens ?? 0,
        cachedTokens: b?.cachedTokens ?? 0,
        outputTokens: b?.outputTokens ?? 0,
        totalTokens: b?.totalTokens ?? 0,
        calls: b?.calls ?? 0,
        estCostYuan: roundYuan(b?.estCostYuan ?? 0)
      })
    }
    return out
  }

  const buildCalendarYearSeries = (year: number): AiUsageSeriesPoint[] => {
    const out: AiUsageSeriesPoint[] = []
    for (let month = 0; month < 12; month += 1) {
      const d = new Date(year, month, 1)
      const key = localMonthKey(d)
      const b = monthBuckets.get(key)
      out.push({
        key,
        label: `${month + 1}月`,
        inputFreshTokens: b?.inputFreshTokens ?? 0,
        cachedTokens: b?.cachedTokens ?? 0,
        outputTokens: b?.outputTokens ?? 0,
        totalTokens: b?.totalTokens ?? 0,
        calls: b?.calls ?? 0,
        estCostYuan: roundYuan(b?.estCostYuan ?? 0)
      })
    }
    return out
  }

  const byKind: AiUsageKindRow[] = Array.from(kindBuckets.entries())
    .map(([api, b]) => ({
      api,
      label: API_KIND_META[api]?.label ?? api,
      calls: b.calls,
      totalTokens: b.totalTokens,
      estCostYuan: roundYuan(b.estCostYuan),
      avgLatencyMs: b.calls > 0 ? Math.round(b.latencySum / b.calls) : 0,
      errorCalls: b.errorCalls
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls)

  const totalEvents = localHits + totalCalls
  const fullCostTotal = estCostYuan + savedCostYuan
  const cacheHitPct = roundPct1(cloudHitRate * 100)
  const localHitPct = roundPct1(totalEvents > 0 ? (localHits / totalEvents) * 100 : 0)
  const batchPct = roundPct1(totalCalls > 0 ? (batchCalls / totalCalls) * 100 : 0)
  const successPct = roundPct1(totalCalls > 0 ? (successCalls / totalCalls) * 100 : 0)
  const savedPct = roundPct1(fullCostTotal > 0 ? (savedCostYuan / fullCostTotal) * 100 : 0)

  const radar: AiUsageRadarAxis[] = [
    { key: 'cacheHit', label: '云端缓存', value: cacheHitPct, display: `${cacheHitPct.toFixed(1)}%` },
    { key: 'localHit', label: '本地省流', value: localHitPct, display: `${localHitPct.toFixed(1)}%` },
    { key: 'batchRatio', label: '批量优惠', value: batchPct, display: `${batchPct.toFixed(1)}%` },
    { key: 'successRate', label: '请求稳定', value: successPct, display: `${successPct.toFixed(1)}%` },
    { key: 'costSaved', label: '费用节省', value: savedPct, display: `${savedPct.toFixed(1)}%` }
  ]

  return {
    summary: {
      totalTokens,
      inputTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      imageTokens,
      totalCalls,
      successCalls,
      errorCalls,
      batchCalls,
      searchCalls,
      estCostYuan: roundedCost,
      savedCostYuan: roundedSaved,
      cloudHitRate,
      localHits
    },
    heatmap,
    availableYears,
    heatmapByYear,
    series: {
      d7: buildDaySeries(7),
      d15: buildDaySeries(15),
      d30: buildDaySeries(30),
      m6: buildMonthSeries(6),
      m12: buildCalendarYearSeries(currentYear)
    },
    byKind,
    radar
  }
}
