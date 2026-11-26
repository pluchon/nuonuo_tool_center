<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  AiUsageDailyPoint,
  AiUsageKindRow,
  AiUsageRadarAxis,
  AiUsageSeriesPoint,
  AiUsageStatsVO
} from '@shared/api'
import { fetchAiUsageStats } from '@/api/ai'

type ViewMode = 'heatmap' | 'trend' | 'radar'
type TrendRange = 'd7' | 'd15' | 'd30' | 'm6' | 'm12'

interface PopoverState {
  leftPx: number
  topPx: number
  flipped: boolean
  caretOffsetPx: number
  title: string
  titleRight?: string
  rows: { label: string; value: string }[]
}

const stats = ref<AiUsageStatsVO | null>(null)
const loading = ref(true)
const loadError = ref('')
const viewMode = ref<ViewMode>('heatmap')
const trendRange = ref<TrendRange>('d7')
const selectedYear = ref(new Date().getFullYear())
const animSeed = ref(0)
const stageRef = ref<HTMLElement | null>(null)
const popover = ref<PopoverState | null>(null)
const activeBarIndex = ref<number | null>(null)
const activeRadarIndex = ref<number | null>(null)

async function loadUsageStats(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchAiUsageStats()
    stats.value = data
    if (data.availableYears.length && !data.availableYears.includes(selectedYear.value)) {
      selectedYear.value = data.availableYears[0]
    }
    animSeed.value += 1
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '用量读取失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadUsageStats()
})

function switchView(next: ViewMode): void {
  viewMode.value = next
  popover.value = null
  activeBarIndex.value = null
  activeRadarIndex.value = null
  animSeed.value += 1
}

function switchRange(next: TrendRange): void {
  trendRange.value = next
  popover.value = null
  activeBarIndex.value = null
  animSeed.value += 1
}

function stepYear(delta: number): void {
  const years = stats.value?.availableYears ?? []
  const idx = years.indexOf(selectedYear.value)
  if (idx < 0) return
  const nextIdx = idx - delta
  if (nextIdx < 0 || nextIdx >= years.length) return
  selectedYear.value = years[nextIdx]
  popover.value = null
  animSeed.value += 1
}

const canPrevYear = computed(() => {
  const years = stats.value?.availableYears ?? []
  const idx = years.indexOf(selectedYear.value)
  return idx >= 0 && idx < years.length - 1
})

const canNextYear = computed(() => {
  const years = stats.value?.availableYears ?? []
  const idx = years.indexOf(selectedYear.value)
  return idx > 0
})

function clearHover(): void {
  popover.value = null
  activeBarIndex.value = null
  activeRadarIndex.value = null
}

function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function formatYuan(n: number): string {
  if (n <= 0) return '0.00'
  if (n < 0.01) return n.toFixed(4)
  if (n < 10) return n.toFixed(3)
  return n.toFixed(2)
}

function formatLatency(ms: number): string {
  if (ms <= 0) return '0ms'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

const kpiCloudHit = computed(() => {
  const s = stats.value?.summary
  if (!s) return '0.0%'
  return `${(s.cloudHitRate * 100).toFixed(1)}%`
})

function heatClass(level: 0 | 1 | 2 | 3 | 4): string {
  return `ai-usage__heat--${level}`
}

// ---- 年度热力图（当年 1月~12月，左侧不标周几） ----
interface HeatCell {
  col: number
  row: number
  x: number
  y: number
  level: 0 | 1 | 2 | 3 | 4
  point: AiUsageDailyPoint
}

const HEAT_PAD_LEFT = 4
const HEAT_PAD_TOP = 18
const HEAT_CELL = 8.4
const HEAT_GAP = 2.4
const HEAT_STEP = HEAT_CELL + HEAT_GAP

const heatmapLayout = computed(() => {
  const points = stats.value?.heatmapByYear?.[selectedYear.value] ?? stats.value?.heatmap ?? []
  if (points.length === 0) {
    return { cells: [] as HeatCell[], monthLabels: [] as { x: number; label: string }[], width: 582, height: 100 }
  }
  const firstParts = points[0].date.split('-').map(Number)
  const firstDate = new Date(firstParts[0], firstParts[1] - 1, firstParts[2])
  const startOffset = (firstDate.getDay() + 6) % 7 // 周一=0 .. 周日=6
  const positiveValues = points.map((p) => p.totalTokens).filter((v) => v > 0)
  const maxVal = positiveValues.length > 0 ? Math.max(...positiveValues) : 0

  const cells: HeatCell[] = []
  const monthLabels: { x: number; label: string }[] = []
  let lastMonth = ''
  let lastLabelX = -100

  points.forEach((pt, idx) => {
    const slot = startOffset + idx
    const col = Math.floor(slot / 7)
    const row = slot % 7
    const x = HEAT_PAD_LEFT + col * HEAT_STEP
    const y = HEAT_PAD_TOP + row * HEAT_STEP

    let level: 0 | 1 | 2 | 3 | 4 = 0
    if (pt.totalTokens > 0 || pt.calls > 0) {
      if (maxVal <= 0) {
        level = 1
      } else {
        const ratio = pt.totalTokens / maxVal
        if (ratio > 0.75) level = 4
        else if (ratio > 0.5) level = 3
        else if (ratio > 0.25) level = 2
        else level = 1
      }
    }

    cells.push({ col, row, x, y, level, point: pt })

    const monthKey = pt.date.slice(0, 7)
    const dayNum = Number(pt.date.slice(8, 10))
    if (monthKey !== lastMonth && (dayNum <= 7 || idx === 0)) {
      lastMonth = monthKey
      if (x - lastLabelX >= 32) {
        monthLabels.push({ x, label: `${Number(pt.date.slice(5, 7))}月` })
        lastLabelX = x
      }
    }
  })

  const totalCols = Math.ceil((startOffset + points.length) / 7)
  const width = Math.max(578, HEAT_PAD_LEFT + totalCols * HEAT_STEP + 4)
  const height = HEAT_PAD_TOP + 7 * HEAT_STEP + 4
  return { cells, monthLabels, width, height }
})

// ---- 趋势堆叠柱图（7天 / 15天 / 30天 / 6个月 / 1年） ----
const BAR_VB_W = 580
const BAR_VB_H = 152
const BAR_LEFT = 42
const BAR_RIGHT = 10
const BAR_TOP = 10
const BAR_BOTTOM = 22
const BAR_PLOT_W = BAR_VB_W - BAR_LEFT - BAR_RIGHT
const BAR_PLOT_H = BAR_VB_H - BAR_TOP - BAR_BOTTOM

interface StackedBarGeom {
  index: number
  point: AiUsageSeriesPoint
  slotX: number
  slotW: number
  barX: number
  barW: number
  cachedY: number
  cachedH: number
  freshY: number
  freshH: number
  outY: number
  outH: number
  topY: number
  showLabel: boolean
}

const activeSeries = computed<AiUsageSeriesPoint[]>(() => {
  if (!stats.value) return []
  return stats.value.series[trendRange.value]
})

const barLayout = computed(() => {
  const list = activeSeries.value
  const count = list.length || 1
  const rawMax = list.reduce((acc, p) => Math.max(acc, p.cachedTokens + p.inputFreshTokens + p.outputTokens), 0)
  const yMax = rawMax > 0 ? Math.ceil(rawMax * 1.12) : 1000
  const slotW = BAR_PLOT_W / count
  const barW = Math.min(24, Math.max(6, slotW * 0.56))

  const bars: StackedBarGeom[] = list.map((pt, index) => {
    const slotX = BAR_LEFT + index * slotW
    const barX = slotX + (slotW - barW) / 2
    const baseBottom = BAR_TOP + BAR_PLOT_H
    const toH = (val: number) => (val <= 0 ? 0 : Math.max(1.5, (val / yMax) * BAR_PLOT_H))

    const cachedH = toH(pt.cachedTokens)
    const freshH = toH(pt.inputFreshTokens)
    const outH = toH(pt.outputTokens)
    const cachedY = baseBottom - cachedH
    const freshY = cachedY - freshH
    const outY = freshY - outH
    const topY = Math.min(cachedY, freshY, outY, baseBottom)

    const showLabel =
      count <= 12 ||
      (count === 15 ? index === 0 || index === 14 || index % 3 === 0 : index === 0 || index === count - 1 || index % 5 === 0)

    return {
      index,
      point: pt,
      slotX,
      slotW,
      barX,
      barW,
      cachedY,
      cachedH,
      freshY,
      freshH,
      outY,
      outH,
      topY,
      showLabel
    }
  })

  const gridLines = [0, 0.5, 1].map((frac) => ({
    y: BAR_TOP + BAR_PLOT_H * (1 - frac),
    label: frac === 0 ? '0' : formatTokens(Math.round(yMax * frac))
  }))

  return { bars, gridLines, yMax }
})

// ---- 5 轴效率雷达（不显示数值占比） + 右侧 3×2 条形场景 ----
const RADAR_CX = 114
const RADAR_CY = 102
const RADAR_R = 60

function polarPoint(index: number, total: number, radius: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / total
  return {
    x: RADAR_CX + radius * Math.cos(angle),
    y: RADAR_CY + radius * Math.sin(angle)
  }
}

const radarLayout = computed(() => {
  const axes = stats.value?.radar ?? []
  const n = axes.length || 5
  const rings = [0.25, 0.5, 0.75, 1].map((frac) => {
    return Array.from({ length: n }, (_, i) => {
      const p = polarPoint(i, n, RADAR_R * frac)
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
    }).join(' ')
  })

  const spokes = axes.map((axis, i) => {
    const outer = polarPoint(i, n, RADAR_R)
    const labelPt = polarPoint(i, n, RADAR_R + 18)
    const valPt = polarPoint(i, n, RADAR_R * (Math.max(6, axis.value) / 100))
    const anchor =
      Math.abs(outer.x - RADAR_CX) < 8
        ? 'middle'
        : outer.x > RADAR_CX
          ? 'start'
          : 'end'
    const dy = outer.y < RADAR_CY - 20 ? -2 : outer.y > RADAR_CY + 20 ? 8 : 3
    return { axis, outer, labelPt, valPt, anchor, dy, index: i }
  })

  const polygonPoints = spokes.map((s) => `${s.valPt.x.toFixed(1)},${s.valPt.y.toFixed(1)}`).join(' ')
  return { rings, spokes, polygonPoints }
})

const kindGridRows = computed(() => (stats.value?.byKind ?? []).slice(0, 6))

const maxKindTokens = computed(() => {
  return Math.max(1, ...kindGridRows.value.map((r) => r.totalTokens))
})

// ---- 通用毛玻璃 V 尖角浮层定位 ----
function showPopoverAtClientPoint(
  anchorRect: { left: number; top: number; width: number; height: number },
  title: string,
  rows: { label: string; value: string }[],
  flipThreshold = 68,
  titleRight?: string
): void {
  const stage = stageRef.value
  if (!stage) return
  const stageRect = stage.getBoundingClientRect()
  const rawX = anchorRect.left + anchorRect.width / 2 - stageRect.left
  const rawTopY = anchorRect.top - stageRect.top
  const rawBottomY = anchorRect.top + anchorRect.height - stageRect.top

  const halfPopW = 92
  const clampedX = Math.min(Math.max(halfPopW, rawX), Math.max(halfPopW, stageRect.width - halfPopW))
  const caretOffsetPx = Math.min(Math.max(-68, rawX - clampedX), 68)
  const flipped = rawTopY < flipThreshold

  popover.value = {
    leftPx: clampedX,
    topPx: flipped ? rawBottomY + 8 : rawTopY - 8,
    flipped,
    caretOffsetPx,
    title,
    titleRight,
    rows
  }
}

function onHeatHover(event: MouseEvent, cell: HeatCell): void {
  const el = event.currentTarget as Element | null
  if (!el) return
  const pt = cell.point
  showPopoverAtClientPoint(
    el.getBoundingClientRect(),
    pt.date,
    [
      { label: '缓存命中', value: formatTokens(pt.cachedTokens) },
      { label: '调用次数', value: `${pt.calls} 次` },
      { label: '估算费用', value: `¥${formatYuan(pt.estCostYuan)}` }
    ],
    -56,
    formatTokens(pt.totalTokens)
  )
}

function onBarHover(event: MouseEvent, bar: StackedBarGeom): void {
  activeBarIndex.value = bar.index
  const el = event.currentTarget as Element | null
  if (!el) return
  const pt = bar.point
  const rect = el.getBoundingClientRect()
  const topAnchorY = rect.top + (bar.topY / BAR_VB_H) * rect.height
  showPopoverAtClientPoint(
    { left: rect.left, top: topAnchorY, width: rect.width, height: 14 },
    pt.key,
    [
      { label: '缓存命中', value: formatTokens(pt.cachedTokens) },
      { label: '新增输入', value: formatTokens(pt.inputFreshTokens) },
      { label: '模型输出', value: formatTokens(pt.outputTokens) },
      { label: '调用次数', value: `${pt.calls} 次` },
      { label: '估算费用', value: `¥${formatYuan(pt.estCostYuan)}` }
    ],
    44,
    formatTokens(pt.totalTokens)
  )
}

function radarHintValue(axis: AiUsageRadarAxis): { label: string; value: string }[] {
  const s = stats.value?.summary
  if (!s) return [{ label: axis.label, value: axis.display }]
  switch (axis.key) {
    case 'cacheHit':
      return [
        { label: '云端命中', value: `${formatTokens(s.cachedTokens)} / ${formatTokens(s.inputTokens)}` },
        { label: '命中率', value: axis.display }
      ]
    case 'localHit':
      return [
        { label: '本地复用', value: `${s.localHits.toLocaleString()} 次` },
        { label: '云端调用', value: `${s.totalCalls.toLocaleString()} 次` }
      ]
    case 'batchRatio':
      return [
        { label: '半价批量', value: `${s.batchCalls.toLocaleString()} / ${s.totalCalls.toLocaleString()} 次` },
        { label: '占比', value: axis.display }
      ]
    case 'successRate':
      return [
        { label: '成功 / 总计', value: `${s.successCalls} / ${s.totalCalls}` },
        { label: '失败次数', value: `${s.errorCalls} 次` }
      ]
    case 'costSaved':
      return [
        { label: '节省金额', value: `¥${formatYuan(s.savedCostYuan)}` },
        { label: '节省比例', value: axis.display }
      ]
  }
}

function onRadarHover(event: MouseEvent, axis: AiUsageRadarAxis, index: number): void {
  activeRadarIndex.value = index
  const el = event.currentTarget as Element | null
  if (!el) return
  showPopoverAtClientPoint(el.getBoundingClientRect(), axis.label, radarHintValue(axis), 48)
}

function onKindHover(event: MouseEvent, row: AiUsageKindRow): void {
  const el = event.currentTarget as Element | null
  if (!el) return
  showPopoverAtClientPoint(
    el.getBoundingClientRect(),
    row.label,
    [
      { label: '调用次数', value: `${row.calls.toLocaleString()} 次` },
      { label: '平均耗时', value: formatLatency(row.avgLatencyMs) },
      { label: '总 Tokens', value: formatTokens(row.totalTokens) },
      { label: '估算费用', value: `¥${formatYuan(row.estCostYuan)}` }
    ],
    20
  )
}
</script>

<template>
  <section class="set-dlg__group ai-usage" aria-label="用量统计">
    <div class="ai-usage__head">
      <h3 class="set-dlg__group-title ai-usage__title">用量统计</h3>

      <div class="ai-usage__tabs" role="tablist" aria-label="用量视图">
        <button
          type="button"
          role="tab"
          class="ai-usage__tab"
          :class="{ 'is-active': viewMode === 'heatmap' }"
          :aria-selected="viewMode === 'heatmap'"
          @click="switchView('heatmap')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="4" y="4" width="6" height="6" rx="1.5" />
            <rect x="14" y="4" width="6" height="6" rx="1.5" />
            <rect x="4" y="14" width="6" height="6" rx="1.5" />
            <rect x="14" y="14" width="6" height="6" rx="1.5" fill="currentColor" fill-opacity="0.35" />
          </svg>
          <span>年度热力</span>
        </button>
        <button
          type="button"
          role="tab"
          class="ai-usage__tab"
          :class="{ 'is-active': viewMode === 'trend' }"
          :aria-selected="viewMode === 'trend'"
          @click="switchView('trend')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 19v-7M12 19V5M18 19v-10" />
          </svg>
          <span>趋势柱图</span>
        </button>
        <button
          type="button"
          role="tab"
          class="ai-usage__tab"
          :class="{ 'is-active': viewMode === 'radar' }"
          :aria-selected="viewMode === 'radar'"
          @click="switchView('radar')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
            <polygon points="12,3 20.5,9.2 17.3,19 6.7,19 3.5,9.2" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
          </svg>
          <span>效率雷达</span>
        </button>
      </div>
    </div>

    <p v-if="loadError" class="ai-usage__state">{{ loadError }}</p>
    <p v-else-if="loading && !stats" class="ai-usage__state">统计载入中...</p>

    <template v-else-if="stats">
      <div class="ai-usage__kpis">
        <div class="ai-usage__kpi">
          <div class="ai-usage__kpi-top">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
            </svg>
            <span class="ai-usage__kpi-label">总 Tokens</span>
          </div>
          <strong class="ai-usage__kpi-val">{{ formatTokens(stats.summary.totalTokens) }}</strong>
        </div>
        <div class="ai-usage__kpi">
          <div class="ai-usage__kpi-top">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.5 8.5L12 12l2.5-3.5M9 12.5h6M12 12v5" />
            </svg>
            <span class="ai-usage__kpi-label">估算费用</span>
          </div>
          <strong class="ai-usage__kpi-val">¥{{ formatYuan(stats.summary.estCostYuan) }}</strong>
        </div>
        <div class="ai-usage__kpi">
          <div class="ai-usage__kpi-top">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
            </svg>
            <span class="ai-usage__kpi-label">云端缓存</span>
          </div>
          <strong class="ai-usage__kpi-val">{{ kpiCloudHit }}</strong>
        </div>
        <div class="ai-usage__kpi">
          <div class="ai-usage__kpi-top">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 12h4l2.5-6 3 12L16 12h4" />
            </svg>
            <span class="ai-usage__kpi-label">调用次数</span>
          </div>
          <strong class="ai-usage__kpi-val">{{ stats.summary.totalCalls.toLocaleString() }}</strong>
        </div>
      </div>

      <div ref="stageRef" class="ai-usage__stage" @mouseleave="clearHover">
        <!-- 1. 全年热力图 -->
        <div v-if="viewMode === 'heatmap'" :key="`heat-${selectedYear}-${animSeed}`" class="ai-usage__panel ai-usage__panel--heat">
          <div class="ai-usage__svg-wrap">
            <svg
              class="ai-usage__heat-svg"
              :viewBox="`0 0 ${heatmapLayout.width} ${heatmapLayout.height}`"
              role="img"
              :aria-label="`${selectedYear}年Token消耗热力图`"
            >
              <text
                v-for="m in heatmapLayout.monthLabels"
                :key="m.x"
                :x="m.x"
                y="11"
                class="ai-usage__svg-axis"
              >{{ m.label }}</text>
              <rect
                v-for="cell in heatmapLayout.cells"
                :key="cell.point.date"
                :x="cell.x"
                :y="cell.y"
                :width="HEAT_CELL"
                :height="HEAT_CELL"
                rx="1.8"
                class="ai-usage__heat-cell"
                :class="heatClass(cell.level)"
                :style="{ '--col-delay': `${Math.min(260, cell.col * 4)}ms` }"
                @mouseenter="onHeatHover($event, cell)"
              />
            </svg>
          </div>

          <div class="ai-usage__foot">
            <div class="ai-usage__year-switch" aria-label="年份切换">
              <button
                type="button"
                class="ai-usage__year-btn"
                :disabled="!canPrevYear"
                aria-label="上一年"
                @click="stepYear(-1)"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <span class="ai-usage__year-label">{{ selectedYear }} 年</span>
              <button
                type="button"
                class="ai-usage__year-btn"
                :disabled="!canNextYear"
                aria-label="下一年"
                @click="stepYear(1)"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>

            <div class="ai-usage__legend">
              <span>少</span>
              <span
                v-for="lv in ([0, 1, 2, 3, 4] as const)"
                :key="lv"
                class="ai-usage__legend-dot"
                :class="heatClass(lv)"
              />
              <span>多</span>
            </div>
          </div>
        </div>

        <!-- 2. 趋势堆叠柱图 -->
        <div v-else-if="viewMode === 'trend'" :key="`trend-${trendRange}-${animSeed}`" class="ai-usage__panel ai-usage__panel--trend">
          <svg
            class="ai-usage__bar-svg"
            :viewBox="`0 0 ${BAR_VB_W} ${BAR_VB_H}`"
            role="img"
            aria-label="Token消耗趋势堆叠柱状图"
          >
            <g v-for="g in barLayout.gridLines" :key="g.y">
              <line
                :x1="BAR_LEFT"
                :x2="BAR_VB_W - BAR_RIGHT"
                :y1="g.y"
                :y2="g.y"
                class="ai-usage__grid-line"
              />
              <text
                :x="BAR_LEFT - 6"
                :y="g.y + 3.5"
                text-anchor="end"
                class="ai-usage__svg-axis"
              >{{ g.label }}</text>
            </g>

            <g v-for="bar in barLayout.bars" :key="bar.point.key">
              <rect
                v-if="activeBarIndex === bar.index"
                :x="bar.slotX + 1"
                :y="BAR_TOP"
                :width="Math.max(2, bar.slotW - 2)"
                :height="BAR_PLOT_H"
                rx="3"
                class="ai-usage__bar-hoverbg"
              />
              <g
                class="ai-usage__bar-anim"
                :style="{
                  transformOrigin: `${bar.barX + bar.barW / 2}px ${BAR_TOP + BAR_PLOT_H}px`,
                  '--bar-delay': `${Math.min(220, bar.index * 10)}ms`
                }"
              >
                <rect
                  v-if="bar.cachedH > 0"
                  :x="bar.barX"
                  :y="bar.cachedY"
                  :width="bar.barW"
                  :height="bar.cachedH"
                  rx="1"
                  class="ai-usage__seg-cached"
                />
                <rect
                  v-if="bar.freshH > 0"
                  :x="bar.barX"
                  :y="bar.freshY"
                  :width="bar.barW"
                  :height="bar.freshH"
                  rx="1"
                  class="ai-usage__seg-fresh"
                />
                <rect
                  v-if="bar.outH > 0"
                  :x="bar.barX"
                  :y="bar.outY"
                  :width="bar.barW"
                  :height="bar.outH"
                  rx="1"
                  class="ai-usage__seg-out"
                />
              </g>
              <text
                v-if="bar.showLabel"
                :x="bar.slotX + bar.slotW / 2"
                :y="BAR_VB_H - 5"
                text-anchor="middle"
                class="ai-usage__svg-axis"
              >{{ bar.point.label }}</text>
              <rect
                :x="bar.slotX"
                :y="BAR_TOP"
                :width="bar.slotW"
                :height="BAR_PLOT_H"
                fill="transparent"
                class="ai-usage__hit-col"
                @mouseenter="onBarHover($event, bar)"
              />
            </g>
          </svg>

          <div class="ai-usage__foot">
            <div class="ai-usage__legend">
              <span class="ai-usage__legend-item">
                <i class="ai-usage__swatch ai-usage__swatch--cached" />缓存命中
              </span>
              <span class="ai-usage__legend-item">
                <i class="ai-usage__swatch ai-usage__swatch--fresh" />新增输入
              </span>
              <span class="ai-usage__legend-item">
                <i class="ai-usage__swatch ai-usage__swatch--out" />模型输出
              </span>
            </div>

            <div class="ai-usage__range-links" role="tablist" aria-label="时间范围">
              <button
                type="button"
                role="tab"
                class="ai-usage__range-link"
                :class="{ 'is-active': trendRange === 'd7' }"
                :aria-selected="trendRange === 'd7'"
                @click="switchRange('d7')"
              >7天</button>
              <button
                type="button"
                role="tab"
                class="ai-usage__range-link"
                :class="{ 'is-active': trendRange === 'd15' }"
                :aria-selected="trendRange === 'd15'"
                @click="switchRange('d15')"
              >15天</button>
              <button
                type="button"
                role="tab"
                class="ai-usage__range-link"
                :class="{ 'is-active': trendRange === 'd30' }"
                :aria-selected="trendRange === 'd30'"
                @click="switchRange('d30')"
              >30天</button>
              <button
                type="button"
                role="tab"
                class="ai-usage__range-link"
                :class="{ 'is-active': trendRange === 'm6' }"
                :aria-selected="trendRange === 'm6'"
                @click="switchRange('m6')"
              >6个月</button>
              <button
                type="button"
                role="tab"
                class="ai-usage__range-link"
                :class="{ 'is-active': trendRange === 'm12' }"
                :aria-selected="trendRange === 'm12'"
                @click="switchRange('m12')"
              >1年</button>
            </div>
          </div>
        </div>

        <!-- 3. 5 轴效率雷达 + 3×2 场景分布 -->
        <div v-else :key="`radar-${animSeed}`" class="ai-usage__panel ai-usage__radar-grid">
          <div class="ai-usage__radar-wrap">
            <svg
              class="ai-usage__radar-svg"
              viewBox="0 0 228 200"
              role="img"
              aria-label="AI省流与效率五维雷达图"
            >
              <polygon
                v-for="(pts, idx) in radarLayout.rings"
                :key="idx"
                :points="pts"
                class="ai-usage__radar-ring"
              />
              <line
                v-for="s in radarLayout.spokes"
                :key="s.axis.key"
                :x1="RADAR_CX"
                :y1="RADAR_CY"
                :x2="s.outer.x"
                :y2="s.outer.y"
                class="ai-usage__radar-spoke"
              />
              <circle :cx="RADAR_CX" :cy="RADAR_CY" r="2.2" class="ai-usage__radar-core" />
              <g class="ai-usage__radar-shape" :style="{ transformOrigin: `${RADAR_CX}px ${RADAR_CY}px` }">
                <polygon :points="radarLayout.polygonPoints" class="ai-usage__radar-area" />
                <circle
                  v-for="s in radarLayout.spokes"
                  :key="`dot-${s.axis.key}`"
                  :cx="s.valPt.x"
                  :cy="s.valPt.y"
                  :r="activeRadarIndex === s.index ? 4.5 : 3.2"
                  class="ai-usage__radar-dot"
                />
              </g>

              <g v-for="s in radarLayout.spokes" :key="`lbl-${s.axis.key}`">
                <text
                  :x="s.labelPt.x"
                  :y="s.labelPt.y + s.dy"
                  :text-anchor="s.anchor"
                  class="ai-usage__radar-lbl"
                >{{ s.axis.label }}</text>
                <circle
                  :cx="s.valPt.x"
                  :cy="s.valPt.y"
                  r="14"
                  fill="transparent"
                  class="ai-usage__hit-col"
                  @mouseenter="onRadarHover($event, s.axis, s.index)"
                />
              </g>
            </svg>
          </div>

          <div class="ai-usage__kinds">
            <div v-if="kindGridRows.length === 0" class="ai-usage__kind-empty">暂无调用记录</div>
            <div
              v-for="(row, rIdx) in kindGridRows"
              :key="row.api"
              class="ai-usage__kind-row"
              @mouseenter="onKindHover($event, row)"
            >
              <span class="ai-usage__kind-name">{{ row.label }}</span>
              <div class="ai-usage__kind-track">
                <div
                  class="ai-usage__kind-fill"
                  :style="{
                    width: `${Math.max(8, (row.totalTokens / maxKindTokens) * 100)}%`,
                    '--row-delay': `${rIdx * 45}ms`
                  }"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 统一毛玻璃 V 尖角浮层 -->
        <div
          v-if="popover"
          class="ai-usage__pop"
          :class="{ 'is-flipped': popover.flipped }"
          :style="{
            left: `${popover.leftPx}px`,
            top: `${popover.topPx}px`,
            '--caret-offset': `${popover.caretOffsetPx}px`
          }"
        >
          <div class="ai-usage__pop-title">
            <span>{{ popover.title }}</span>
            <strong v-if="popover.titleRight">{{ popover.titleRight }}</strong>
          </div>
          <div v-for="r in popover.rows" :key="r.label" class="ai-usage__pop-row">
            <span>{{ r.label }}</span>
            <strong>{{ r.value }}</strong>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.ai-usage {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px 16px;
}

.ai-usage__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ai-usage__title {
  padding: 0;
}

.ai-usage__tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  border: 1px solid var(--settings-rule);
  background: color-mix(in srgb, var(--c-i-9C90B3) 8%, transparent);
}

.ai-usage__tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--c-i-6E6280);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    border-color 0.16s ease;

  &:hover:not(.is-active) {
    background: var(--a06);
    color: var(--c-i-3B3047);
  }

  &.is-active {
    background: var(--a-soft);
    border-color: var(--a-line2);
    color: var(--a-ink);
    font-weight: 700;
  }
}

.ai-usage__state {
  margin: 0;
  padding: 20px 0;
  font-size: 12px;
  color: var(--c-i-7F7494);
  text-align: center;
}

.ai-usage__kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.ai-usage__kpi {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--settings-rule);
  background: color-mix(in srgb, var(--a) 2.5%, var(--settings-card));
  font-variant-numeric: tabular-nums;
}

.ai-usage__kpi-top {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--c-i-7F7494);
}

.ai-usage__kpi-label {
  font-size: 11px;
  color: var(--c-i-7F7494);
}

.ai-usage__kpi-val {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--a-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-usage__stage {
  position: relative;
  height: 228px;
  box-sizing: border-box;
  border: 1px solid var(--settings-rule);
  border-radius: 10px;
  background: color-mix(in srgb, var(--a) 2%, var(--settings-card));
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
}

.ai-usage__panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
}

.ai-usage__svg-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
}

.ai-usage__heat-svg,
.ai-usage__bar-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.ai-usage__bar-svg {
  flex: 1;
  min-height: 0;
}

.ai-usage__heat-cell {
  cursor: default;
  transform-box: fill-box;
  transform-origin: center;
  animation: ai-usage-heat-in 0.36s cubic-bezier(0.22, 1, 0.36, 1) var(--col-delay, 0ms) both;
  transition: stroke 0.12s ease;
}

.ai-usage__heat-cell:hover {
  stroke: var(--a-ink);
  stroke-width: 1;
}

.ai-usage__heat--0 {
  fill: color-mix(in srgb, var(--c-i-9C90B3) 22%, transparent);
  background: color-mix(in srgb, var(--c-i-9C90B3) 22%, transparent);
}

.ai-usage__heat--1 {
  fill: color-mix(in srgb, var(--a) 26%, var(--c-surface));
  background: color-mix(in srgb, var(--a) 26%, var(--c-surface));
}

.ai-usage__heat--2 {
  fill: color-mix(in srgb, var(--a) 48%, var(--c-surface));
  background: color-mix(in srgb, var(--a) 48%, var(--c-surface));
}

.ai-usage__heat--3 {
  fill: color-mix(in srgb, var(--a) 72%, var(--c-surface));
  background: color-mix(in srgb, var(--a) 72%, var(--c-surface));
}

.ai-usage__heat--4 {
  fill: var(--a);
  background: var(--a);
}

.ai-usage__svg-axis {
  fill: var(--c-i-7F7494);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.ai-usage__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ai-usage__year-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}

.ai-usage__year-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--c-i-6E6280);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.14s, color 0.14s;

  &:hover:not(:disabled) {
    background: var(--a06);
    color: var(--a-ink);
  }

  &:disabled {
    opacity: 0.3;
    cursor: default;
  }
}

.ai-usage__year-label {
  position: relative;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--c-i-3B3047);
  padding: 1px 2px 3px;
  border-bottom: 1.5px solid var(--a-line);
}

.ai-usage__legend {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--c-i-7F7494);
}

.ai-usage__legend-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.ai-usage__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.ai-usage__swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.ai-usage__swatch--cached,
.ai-usage__seg-cached {
  background: var(--a);
  fill: var(--a);
}

.ai-usage__swatch--fresh,
.ai-usage__seg-fresh {
  background: color-mix(in srgb, var(--a) 54%, var(--c-surface));
  fill: color-mix(in srgb, var(--a) 54%, var(--c-surface));
}

.ai-usage__swatch--out,
.ai-usage__seg-out {
  background: color-mix(in srgb, var(--a) 28%, var(--c-i-7F7494));
  fill: color-mix(in srgb, var(--a) 28%, var(--c-i-7F7494));
}

.ai-usage__range-links {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.ai-usage__range-link {
  position: relative;
  padding: 2px 1px 4px;
  border: 0;
  background: transparent;
  color: var(--c-i-7F7494);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.14s ease;

  &:hover:not(.is-active) {
    color: var(--c-i-3B3047);
  }

  &.is-active {
    color: var(--a-ink);
    font-weight: 700;

    &::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      border-radius: 2px;
      background: var(--a);
    }
  }
}

.ai-usage__grid-line {
  stroke: var(--settings-rule);
  stroke-width: 1;
  stroke-dasharray: 2 3;
}

.ai-usage__bar-hoverbg {
  fill: var(--a06);
}

.ai-usage__bar-anim {
  animation: ai-usage-bar-up 0.42s cubic-bezier(0.22, 1, 0.36, 1) var(--bar-delay, 0ms) both;
}

.ai-usage__hit-col {
  cursor: pointer;
}

.ai-usage__radar-grid {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  align-items: center;
  gap: 16px;
}

.ai-usage__radar-wrap {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
}

.ai-usage__radar-svg {
  width: 206px;
  max-width: 100%;
  height: auto;
  overflow: visible;
}

.ai-usage__radar-ring {
  fill: color-mix(in srgb, var(--a) 2%, transparent);
  stroke: var(--settings-rule);
  stroke-width: 1;
}

.ai-usage__radar-spoke {
  stroke: var(--settings-rule);
  stroke-width: 1;
  stroke-dasharray: 2 2;
}

.ai-usage__radar-core {
  fill: var(--a-line);
}

.ai-usage__radar-shape {
  animation: ai-usage-radar-bloom 0.48s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.ai-usage__radar-area {
  fill: color-mix(in srgb, var(--a) 24%, transparent);
  stroke: var(--a);
  stroke-width: 1.8;
  stroke-linejoin: round;
}

.ai-usage__radar-dot {
  fill: var(--a);
  stroke: var(--c-surface);
  stroke-width: 1.3;
  transition: r 0.14s ease;
}

.ai-usage__radar-lbl {
  fill: var(--c-i-5E5270);
  font-size: 9.5px;
  font-weight: 600;
}

.ai-usage__kinds {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: center;
  gap: 14px 16px;
  min-width: 0;
  max-height: 100%;
  overflow: hidden;
}

.ai-usage__kind-empty {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--c-i-7F7494);
  text-align: center;
  padding: 20px 0;
}

.ai-usage__kind-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 6px;
  transition: background 0.14s ease;
  cursor: default;

  &:hover {
    background: var(--a06);
  }
}

.ai-usage__kind-name {
  font-size: 11.5px;
  color: var(--c-i-3B3047);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-usage__kind-track {
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--c-i-9C90B3) 20%, transparent);
  overflow: hidden;
}

.ai-usage__kind-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--a);
  transform-origin: left center;
  animation: ai-usage-kind-slide 0.45s cubic-bezier(0.22, 1, 0.36, 1) var(--row-delay, 0ms) both;
}

.ai-usage__pop {
  position: absolute;
  transform: translate(-50%, -100%);
  min-width: 176px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--look-edge);
  background: var(--look-pop-bg);
  backdrop-filter: var(--look-pop-blur);
  -webkit-backdrop-filter: var(--look-pop-blur);
  box-shadow: 0 10px 24px rgba(var(--sh), 0.18);
  pointer-events: none;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.ai-usage__pop.is-flipped {
  transform: translate(-50%, 0);
}

.ai-usage__pop::before {
  content: '';
  position: absolute;
  left: calc(50% + var(--caret-offset, 0px));
  bottom: -5px;
  width: 8px;
  height: 8px;
  background: var(--look-pop-caret-bg);
  border-right: 1px solid var(--look-edge);
  border-bottom: 1px solid var(--look-edge);
  transform: translateX(-50%) rotate(45deg);
}

.ai-usage__pop.is-flipped::before {
  bottom: auto;
  top: -5px;
  border-right: none;
  border-bottom: none;
  border-left: 1px solid var(--look-edge);
  border-top: 1px solid var(--look-edge);
}

.ai-usage__pop-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--c-i-3B3047);
  border-bottom: 1px solid var(--settings-rule);
  padding-bottom: 3px;
  margin-bottom: 1px;

  strong {
    font-weight: 700;
    color: var(--a-ink);
  }
}

.ai-usage__pop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  color: var(--c-i-5E5270);
}

.ai-usage__pop-row strong {
  font-weight: 600;
  color: var(--a-ink);
}

@keyframes ai-usage-heat-in {
  from {
    opacity: 0;
    transform: scale(0.55);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes ai-usage-bar-up {
  from {
    opacity: 0.35;
    transform: scaleY(0.05);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}

@keyframes ai-usage-radar-bloom {
  from {
    opacity: 0;
    transform: scale(0.18);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes ai-usage-kind-slide {
  from {
    opacity: 0.4;
    transform: scaleX(0);
  }
  to {
    opacity: 1;
    transform: scaleX(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-usage__heat-cell,
  .ai-usage__bar-anim,
  .ai-usage__radar-shape,
  .ai-usage__kind-fill {
    animation: none;
  }
}

@media (max-width: 560px) {
  .ai-usage__kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ai-usage__stage {
    height: auto;
    min-height: 228px;
  }

  .ai-usage__radar-grid {
    grid-template-columns: 1fr;
  }
}
</style>
