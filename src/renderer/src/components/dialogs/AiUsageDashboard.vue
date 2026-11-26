<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  AiUsageDailyPoint,
  AiUsageRadarAxis,
  AiUsageSeriesPoint,
  AiUsageStatsVO
} from '@shared/api'
import { fetchAiUsageStats } from '@/api/ai'

type ViewMode = 'heatmap' | 'trend' | 'radar'
type TrendRange = 'd7' | 'd30' | 'm12'

interface PopoverState {
  leftPx: number
  topPx: number
  flipped: boolean
  caretOffsetPx: number
  title: string
  rows: { label: string; value: string }[]
}

const stats = ref<AiUsageStatsVO | null>(null)
const loading = ref(true)
const loadError = ref('')
const viewMode = ref<ViewMode>('heatmap')
const trendRange = ref<TrendRange>('d7')
const stageRef = ref<HTMLElement | null>(null)
const popover = ref<PopoverState | null>(null)
const activeBarIndex = ref<number | null>(null)
const activeRadarIndex = ref<number | null>(null)

async function loadUsageStats(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    stats.value = await fetchAiUsageStats()
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
}

function switchRange(next: TrendRange): void {
  trendRange.value = next
  popover.value = null
  activeBarIndex.value = null
}

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

const kpiSuccessRate = computed(() => {
  const s = stats.value?.summary
  if (!s || s.totalCalls === 0) return '0%'
  return `${((s.successCalls / s.totalCalls) * 100).toFixed(1)}%`
})

const kpiCloudHit = computed(() => {
  const s = stats.value?.summary
  if (!s) return '0.0%'
  return `${(s.cloudHitRate * 100).toFixed(1)}%`
})

// ---- 年度热力图（53 周 × 7 天，周一置顶） ----
interface HeatCell {
  col: number
  row: number
  x: number
  y: number
  level: 0 | 1 | 2 | 3 | 4
  point: AiUsageDailyPoint
}

const HEAT_PAD_LEFT = 20
const HEAT_PAD_TOP = 16
const HEAT_CELL = 8.4
const HEAT_GAP = 2.4
const HEAT_STEP = HEAT_CELL + HEAT_GAP

const heatmapLayout = computed(() => {
  const points = stats.value?.heatmap ?? []
  if (points.length === 0) {
    return { cells: [] as HeatCell[], monthLabels: [] as { x: number; label: string }[], activeDays: 0, width: 604, height: 100 }
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
  let activeDays = 0

  points.forEach((pt, idx) => {
    const slot = startOffset + idx
    const col = Math.floor(slot / 7)
    const row = slot % 7
    const x = HEAT_PAD_LEFT + col * HEAT_STEP
    const y = HEAT_PAD_TOP + row * HEAT_STEP

    let level: 0 | 1 | 2 | 3 | 4 = 0
    if (pt.totalTokens > 0 || pt.calls > 0) {
      activeDays += 1
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
  const width = Math.max(596, HEAT_PAD_LEFT + totalCols * HEAT_STEP + 4)
  const height = HEAT_PAD_TOP + 7 * HEAT_STEP + 2
  return { cells, monthLabels, activeDays, width, height }
})

function heatFill(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return 'color-mix(in srgb, var(--t2) 9%, transparent)'
    case 1:
      return 'color-mix(in srgb, var(--a) 26%, var(--c-surface))'
    case 2:
      return 'color-mix(in srgb, var(--a) 48%, var(--c-surface))'
    case 3:
      return 'color-mix(in srgb, var(--a) 72%, var(--c-surface))'
    case 4:
      return 'var(--a)'
  }
}

// ---- 趋势堆叠柱图（Claude 风格） ----
const BAR_VB_W = 600
const BAR_VB_H = 166
const BAR_LEFT = 42
const BAR_RIGHT = 12
const BAR_TOP = 14
const BAR_BOTTOM = 24
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
  const barW = Math.min(26, Math.max(6, slotW * 0.58))

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
      index === 0 ||
      index === count - 1 ||
      index % 5 === 0

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

// ---- 5 轴效率雷达 + 场景分布 ----
const RADAR_CX = 122
const RADAR_CY = 104
const RADAR_R = 64

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
    const pts = Array.from({ length: n }, (_, i) => {
      const p = polarPoint(i, n, RADAR_R * frac)
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
    }).join(' ')
    return pts
  })

  const spokes = axes.map((axis, i) => {
    const outer = polarPoint(i, n, RADAR_R)
    const labelPt = polarPoint(i, n, RADAR_R + 22)
    const valPt = polarPoint(i, n, RADAR_R * (Math.max(4, axis.value) / 100))
    const anchor =
      Math.abs(outer.x - RADAR_CX) < 8
        ? 'middle'
        : outer.x > RADAR_CX
          ? 'start'
          : 'end'
    return { axis, outer, labelPt, valPt, anchor, index: i }
  })

  const polygonPoints = spokes.map((s) => `${s.valPt.x.toFixed(1)},${s.valPt.y.toFixed(1)}`).join(' ')
  return { rings, spokes, polygonPoints }
})

const maxKindTokens = computed(() => {
  const rows = stats.value?.byKind ?? []
  return Math.max(1, ...rows.map((r) => r.totalTokens))
})

// ---- 通用毛玻璃 V 尖角浮层定位 ----
function showPopoverAtClientPoint(
  anchorRect: { left: number; top: number; width: number; height: number },
  title: string,
  rows: { label: string; value: string }[]
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
  const flipped = rawTopY < 76

  popover.value = {
    leftPx: clampedX,
    topPx: flipped ? rawBottomY + 8 : rawTopY - 8,
    flipped,
    caretOffsetPx,
    title,
    rows
  }
}

function onHeatHover(event: MouseEvent, cell: HeatCell): void {
  const el = event.currentTarget as Element | null
  if (!el) return
  const pt = cell.point
  showPopoverAtClientPoint(el.getBoundingClientRect(), pt.date, [
    { label: '总计', value: `${formatTokens(pt.totalTokens)} tokens` },
    { label: '缓存命中', value: formatTokens(pt.cachedTokens) },
    { label: '调用 · 费用', value: `${pt.calls} 次 · ¥${formatYuan(pt.estCostYuan)}` }
  ])
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
      { label: '调用 · 费用', value: `${pt.calls} 次 · ¥${formatYuan(pt.estCostYuan)}` }
    ]
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
        { label: '失败', value: `${s.errorCalls} 次` }
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
  showPopoverAtClientPoint(el.getBoundingClientRect(), axis.label, radarHintValue(axis))
}
</script>

<template>
  <section class="set-dlg__group ai-usage" aria-label="用量统计">
    <div class="ai-usage__head">
      <h3 class="set-dlg__group-title">用量统计</h3>
      <div class="set-dlg__seg" role="tablist" aria-label="用量视图">
        <button
          type="button"
          role="tab"
          class="set-dlg__seg-btn"
          :class="{ 'is-active': viewMode === 'heatmap' }"
          :aria-selected="viewMode === 'heatmap'"
          @click="switchView('heatmap')"
        >年度热力</button>
        <button
          type="button"
          role="tab"
          class="set-dlg__seg-btn"
          :class="{ 'is-active': viewMode === 'trend' }"
          :aria-selected="viewMode === 'trend'"
          @click="switchView('trend')"
        >趋势柱图</button>
        <button
          type="button"
          role="tab"
          class="set-dlg__seg-btn"
          :class="{ 'is-active': viewMode === 'radar' }"
          :aria-selected="viewMode === 'radar'"
          @click="switchView('radar')"
        >效率雷达</button>
      </div>
    </div>

    <p v-if="loadError" class="ai-usage__state">{{ loadError }}</p>
    <p v-else-if="loading && !stats" class="ai-usage__state">统计载入中...</p>

    <template v-else-if="stats">
      <div class="ai-usage__kpis">
        <div class="ai-usage__kpi">
          <span class="ai-usage__kpi-label">总 Tokens</span>
          <strong class="ai-usage__kpi-val">{{ formatTokens(stats.summary.totalTokens) }}</strong>
          <span class="ai-usage__kpi-sub">输入 {{ formatTokens(stats.summary.inputTokens) }} · 输出 {{ formatTokens(stats.summary.outputTokens) }}</span>
        </div>
        <div class="ai-usage__kpi">
          <span class="ai-usage__kpi-label">估算费用</span>
          <strong class="ai-usage__kpi-val">¥{{ formatYuan(stats.summary.estCostYuan) }}</strong>
          <span class="ai-usage__kpi-sub">缓存与批量已省 ¥{{ formatYuan(stats.summary.savedCostYuan) }}</span>
        </div>
        <div class="ai-usage__kpi">
          <span class="ai-usage__kpi-label">云端缓存</span>
          <strong class="ai-usage__kpi-val">{{ kpiCloudHit }}</strong>
          <span class="ai-usage__kpi-sub">本地省流 {{ stats.summary.localHits.toLocaleString() }} 次</span>
        </div>
        <div class="ai-usage__kpi">
          <span class="ai-usage__kpi-label">调用次数</span>
          <strong class="ai-usage__kpi-val">{{ stats.summary.totalCalls.toLocaleString() }}</strong>
          <span class="ai-usage__kpi-sub">成功率 {{ kpiSuccessRate }} · 搜索 {{ stats.summary.searchCalls }}</span>
        </div>
      </div>

      <div ref="stageRef" class="ai-usage__stage" @mouseleave="clearHover">
        <!-- 1. 年度热力图 -->
        <div v-if="viewMode === 'heatmap'" class="ai-usage__panel">
          <svg
            class="ai-usage__heat-svg"
            :viewBox="`0 0 ${heatmapLayout.width} ${heatmapLayout.height}`"
            role="img"
            aria-label="近365天Token消耗热力图"
          >
            <text
              v-for="m in heatmapLayout.monthLabels"
              :key="m.x"
              :x="m.x"
              y="10"
              class="ai-usage__svg-axis"
            >{{ m.label }}</text>
            <text x="2" :y="HEAT_PAD_TOP + 0 * HEAT_STEP + 7" class="ai-usage__svg-axis">一</text>
            <text x="2" :y="HEAT_PAD_TOP + 2 * HEAT_STEP + 7" class="ai-usage__svg-axis">三</text>
            <text x="2" :y="HEAT_PAD_TOP + 4 * HEAT_STEP + 7" class="ai-usage__svg-axis">五</text>
            <rect
              v-for="cell in heatmapLayout.cells"
              :key="cell.point.date"
              :x="cell.x"
              :y="cell.y"
              :width="HEAT_CELL"
              :height="HEAT_CELL"
              rx="1.8"
              :fill="heatFill(cell.level)"
              class="ai-usage__heat-cell"
              @mouseenter="onHeatHover($event, cell)"
            />
          </svg>
          <div class="ai-usage__foot">
            <span class="ai-usage__foot-meta">近 365 天活跃 {{ heatmapLayout.activeDays }} 天</span>
            <div class="ai-usage__legend">
              <span>少</span>
              <span
                v-for="lv in ([0, 1, 2, 3, 4] as const)"
                :key="lv"
                class="ai-usage__legend-dot"
                :style="{ background: heatFill(lv) }"
              />
              <span>多</span>
            </div>
          </div>
        </div>

        <!-- 2. Claude 风格堆叠柱图 -->
        <div v-else-if="viewMode === 'trend'" class="ai-usage__panel">
          <div class="ai-usage__subbar">
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
            <div class="set-dlg__seg ai-usage__subseg" role="tablist" aria-label="时间范围">
              <button
                type="button"
                role="tab"
                class="set-dlg__seg-btn"
                :class="{ 'is-active': trendRange === 'd7' }"
                :aria-selected="trendRange === 'd7'"
                @click="switchRange('d7')"
              >7天</button>
              <button
                type="button"
                role="tab"
                class="set-dlg__seg-btn"
                :class="{ 'is-active': trendRange === 'd30' }"
                :aria-selected="trendRange === 'd30'"
                @click="switchRange('d30')"
              >30天</button>
              <button
                type="button"
                role="tab"
                class="set-dlg__seg-btn"
                :class="{ 'is-active': trendRange === 'm12' }"
                :aria-selected="trendRange === 'm12'"
                @click="switchRange('m12')"
              >12个月</button>
            </div>
          </div>

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
              <text
                v-if="bar.showLabel"
                :x="bar.slotX + bar.slotW / 2"
                :y="BAR_VB_H - 6"
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
        </div>

        <!-- 3. 5 轴效率雷达 + 场景耗时费用分布 -->
        <div v-else class="ai-usage__panel ai-usage__radar-grid">
          <div class="ai-usage__radar-wrap">
            <svg
              class="ai-usage__radar-svg"
              viewBox="0 0 244 206"
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
              <polygon :points="radarLayout.polygonPoints" class="ai-usage__radar-area" />

              <g v-for="s in radarLayout.spokes" :key="`lbl-${s.axis.key}`">
                <text
                  :x="s.labelPt.x"
                  :y="s.labelPt.y - 2"
                  :text-anchor="s.anchor"
                  class="ai-usage__radar-lbl"
                >{{ s.axis.label }}</text>
                <text
                  :x="s.labelPt.x"
                  :y="s.labelPt.y + 10"
                  :text-anchor="s.anchor"
                  class="ai-usage__radar-val"
                >{{ s.axis.display }}</text>
                <circle
                  :cx="s.valPt.x"
                  :cy="s.valPt.y"
                  :r="activeRadarIndex === s.index ? 4.5 : 3"
                  class="ai-usage__radar-dot"
                />
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
            <div v-if="stats.byKind.length === 0" class="ai-usage__kind-empty">暂无调用记录</div>
            <div v-for="row in stats.byKind" :key="row.api" class="ai-usage__kind-row">
              <div class="ai-usage__kind-top">
                <span class="ai-usage__kind-name">{{ row.label }}</span>
                <span class="ai-usage__kind-meta">
                  {{ row.calls }} 次 · {{ formatLatency(row.avgLatencyMs) }} · {{ formatTokens(row.totalTokens) }} · ¥{{ formatYuan(row.estCostYuan) }}
                </span>
              </div>
              <div class="ai-usage__kind-track">
                <div
                  class="ai-usage__kind-fill"
                  :style="{ width: `${Math.max(4, (row.totalTokens / maxKindTokens) * 100)}%` }"
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
          <div class="ai-usage__pop-title">{{ popover.title }}</div>
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
  gap: 10px;
}

.ai-usage__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ai-usage__state {
  margin: 0;
  padding: 16px 0;
  font-size: 12px;
  color: var(--t3);
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
  gap: 3px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--settings-rule);
  background: var(--settings-card);
  font-variant-numeric: tabular-nums;
}

.ai-usage__kpi-label {
  font-size: 11px;
  color: var(--t3);
}

.ai-usage__kpi-val {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--a-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-usage__kpi-sub {
  font-size: 10.5px;
  color: var(--t3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-usage__stage {
  position: relative;
  border: 1px solid var(--settings-rule);
  border-radius: 8px;
  background: var(--settings-card);
  padding: 10px 12px;
}

.ai-usage__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-usage__heat-svg,
.ai-usage__bar-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.ai-usage__heat-cell {
  transition: opacity 0.12s ease;
  cursor: default;
}

.ai-usage__heat-cell:hover {
  stroke: var(--a-ink);
  stroke-width: 1;
}

.ai-usage__svg-axis {
  fill: var(--t3);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.ai-usage__foot,
.ai-usage__subbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ai-usage__foot-meta {
  font-size: 11px;
  color: var(--t3);
  font-variant-numeric: tabular-nums;
}

.ai-usage__legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--t3);
}

.ai-usage__legend-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.ai-usage__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
  background: color-mix(in srgb, var(--a) 24%, var(--t2));
  fill: color-mix(in srgb, var(--a) 24%, var(--t2));
}

.ai-usage__subseg {
  transform: scale(0.92);
  transform-origin: right center;
}

.ai-usage__grid-line {
  stroke: var(--settings-rule);
  stroke-width: 1;
}

.ai-usage__bar-hoverbg {
  fill: var(--a06);
}

.ai-usage__hit-col {
  cursor: pointer;
}

.ai-usage__radar-grid {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  align-items: center;
  gap: 14px;
}

.ai-usage__radar-wrap {
  display: flex;
  justify-content: center;
}

.ai-usage__radar-svg {
  width: 214px;
  max-width: 100%;
  height: auto;
  overflow: visible;
}

.ai-usage__radar-ring {
  fill: none;
  stroke: var(--settings-rule);
  stroke-width: 1;
}

.ai-usage__radar-spoke {
  stroke: var(--settings-rule);
  stroke-width: 1;
}

.ai-usage__radar-area {
  fill: color-mix(in srgb, var(--a) 22%, transparent);
  stroke: var(--a);
  stroke-width: 1.75;
  stroke-linejoin: round;
}

.ai-usage__radar-dot {
  fill: var(--a);
  stroke: var(--c-surface);
  stroke-width: 1.2;
}

.ai-usage__radar-lbl {
  fill: var(--t2);
  font-size: 9.5px;
  font-weight: 500;
}

.ai-usage__radar-val {
  fill: var(--a-ink);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.ai-usage__kinds {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.ai-usage__kind-empty {
  font-size: 12px;
  color: var(--t3);
  text-align: center;
  padding: 18px 0;
}

.ai-usage__kind-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ai-usage__kind-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}

.ai-usage__kind-name {
  font-size: 12px;
  color: var(--t1);
  font-weight: 500;
  white-space: nowrap;
}

.ai-usage__kind-meta {
  font-size: 11px;
  color: var(--t3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-usage__kind-track {
  height: 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--t2) 10%, transparent);
  overflow: hidden;
}

.ai-usage__kind-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--a);
  transition: width 0.25s ease;
}

.ai-usage__pop {
  position: absolute;
  transform: translate(-50%, -100%);
  min-width: 174px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--look-edge);
  background: var(--look-pop-bg);
  backdrop-filter: var(--look-pop-blur);
  -webkit-backdrop-filter: var(--look-pop-blur);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.14);
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
  font-size: 11px;
  font-weight: 600;
  color: var(--t1);
  border-bottom: 1px solid var(--settings-rule);
  padding-bottom: 3px;
  margin-bottom: 1px;
}

.ai-usage__pop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  color: var(--t2);
}

.ai-usage__pop-row strong {
  font-weight: 600;
  color: var(--a-ink);
}

@media (max-width: 560px) {
  .ai-usage__kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ai-usage__radar-grid {
    grid-template-columns: 1fr;
  }
}
</style>
