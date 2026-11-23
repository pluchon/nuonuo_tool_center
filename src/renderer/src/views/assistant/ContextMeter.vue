<template>
  <span class="context-meter" tabindex="0" role="meter" aria-label="对话上下文窗口"
    :aria-valuemin="0" :aria-valuemax="AI_CONTEXT_WINDOW" :aria-valuenow="Math.min(used, AI_CONTEXT_WINDOW)"
    :aria-valuetext="usage ? legend : '暂无模型请求用量记录'" aria-describedby="assistant-context-tooltip"
    @mouseenter="hovered = true" @mouseleave="hovered = false"
    @focus="focused = true" @blur="focused = false" @keydown.esc="hovered = focused = false">
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle class="context-meter__track" cx="10" cy="10" r="7.5" />
      <circle v-if="used" cx="10" cy="10" r="7.5" pathLength="100" :stroke-dasharray="`${percent} 100`" transform="rotate(-90 10 10)" />
    </svg>
    <span v-if="hovered || focused" id="assistant-context-tooltip" role="tooltip" class="context-meter__tip">
      <strong>上下文窗口</strong>
      <span v-if="usage">{{ percentText }} 已使用</span>
      <span v-else-if="messages.length">暂无模型请求用量记录</span>
      <span>{{ legend }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { AI_CONTEXT_WINDOW, type AiMessageVO } from '@shared/api'

const props = defineProps<{ messages: AiMessageVO[] }>()
const hovered = ref(false)
const focused = ref(false)
// 工具往返、缓存命中和本地回复均不累加到上一次请求的上下文。
const usage = computed(() => props.messages.findLast((message) => message.contextUsage)?.contextUsage)
const used = computed(() => usage.value?.usedTokens ?? 0)
const percent = computed(() => Math.min(100, used.value / AI_CONTEXT_WINDOW * 100))
const percentText = computed(() => percent.value > 0 && percent.value < 1 ? '<1%' : Math.round(percent.value) + '%')
const legend = computed(() => usage.value
  ? `${usage.value.compacted ? '精简后估算' : usage.value.estimated ? '最近请求估算' : '最近请求'} ${used.value.toLocaleString('zh-CN')} / 475K Token`
  : `${props.messages.length ? '—' : '0'} / 475K Token`)
</script>

<style scoped>
.context-meter {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 28px;
  border-radius: 7px;
  color: var(--a-ink);
}
.context-meter:focus-visible { outline: 2px solid var(--a); }
.context-meter circle { stroke: currentColor; stroke-width: 2.6; }
.context-meter__track { opacity: 0.25; }
.context-meter__tip {
  position: absolute;
  z-index: 4;
  bottom: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  gap: 3px;
  padding: 8px 12px;
  border-radius: 9px;
  color: var(--c-i-2E2440);
  background: var(--ai-menu-bg);
  border: 1px solid var(--a-line2);
  box-shadow: 0 3px 16px #22132d20;
  white-space: nowrap;
  text-align: center;
  font-size: 12px;
  pointer-events: none;
}
</style>
