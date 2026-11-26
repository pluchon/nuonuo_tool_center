<template>
  <template v-if="data">
    <section class="set-dlg__group" aria-label="后台画面索引">
      <h3 class="set-dlg__group-title">后台画面索引</h3>
      <div class="set-dlg__row">
        <span class="set-dlg__label">云端处理</span>
        <div class="set-dlg__ctl">
          <div class="set-dlg__seg" role="group" aria-label="云端处理">
            <button v-for="option in modes" :key="option.id" type="button" class="set-dlg__seg-btn"
              :class="{ 'set-dlg__seg-btn--on': mode === option.id }" :aria-pressed="mode === option.id"
              :disabled="busy" @click="choose(option.id)">{{ option.label }}</button>
          </div>
        </div>
      </div>
      <div v-if="mode === 'limited'" class="set-dlg__row set-dlg__row--sep">
        <label for="ai-embed-limit" class="set-dlg__label">每日限量</label>
        <div class="set-dlg__ctl">
          <input id="ai-embed-limit" class="set-dlg__credential policy-limit" type="number" min="1" max="10000" placeholder="张数"
            aria-label="后台向量每日上限" :value="data.dailyLimit > 0 ? data.dailyLimit : ''" :disabled="busy" @change="limit" />
          <span class="set-dlg__value">张</span>
        </div>
      </div>
      <div class="set-dlg__row set-dlg__row--sep">
        <span class="set-dlg__label">待建立索引</span>
        <div class="set-dlg__ctl"><strong class="policy-number">{{ data.pendingImages.toLocaleString() }} 张</strong></div>
      </div>
      <div class="set-dlg__row set-dlg__row--sep">
        <span class="set-dlg__label">今日已请求</span>
        <div class="set-dlg__ctl"><span class="set-dlg__value">{{ data.dailyUsed.toLocaleString() }} 张</span></div>
      </div>
    </section>
    <AiUsageDashboard />
  </template>
  <p v-if="error" role="alert">{{ error }}</p>
</template>
<script setup lang="ts">
import AiUsageDashboard from './AiUsageDashboard.vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import type { AiPolicyVO, ApiResponse } from '@shared/api'
const data = ref<AiPolicyVO | null>(null)
const busy = ref(false)
const error = ref('')
const modes = [{ id: 'paused', label: '暂停' }, { id: 'limited', label: '每日限量' }, { id: 'all', label: '不限量' }] as const
type Mode = (typeof modes)[number]['id']
const choosingLimit = ref(false)
const mode = computed<Mode>(() => choosingLimit.value || (data.value?.dailyLimit ?? 0) > 0 ? 'limited' : data.value?.dailyLimit === -1 ? 'all' : 'paused')
async function refresh() {
  const response = await window.api.ai.policy()
  if (!response.ok) throw new Error(response.message)
  data.value = response.data
}
async function save(operation: () => Promise<ApiResponse<void>>) {
  if (busy.value) return
  busy.value = true
  try {
    const response = await operation()
    if (!response.ok) throw new Error(response.message)
    await refresh()
    error.value = ''
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
async function choose(value: Mode) {
  if (mode.value === value) return
  if (value === 'limited') {
    // 从不限量切换时先停止请求，避免填写限额期间仍持续计费。
    if (data.value?.dailyLimit === -1) {
      await save(() => window.api.ai.embeddingLimit(0))
      if (data.value?.dailyLimit === -1) return
    }
    choosingLimit.value = true
    await nextTick()
    document.getElementById('ai-embed-limit')?.focus()
  } else {
    choosingLimit.value = false
    await save(() => window.api.ai.embeddingLimit(value === 'all' ? -1 : 0))
  }
}
async function limit(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.value && input.validity.valid) await save(() => window.api.ai.embeddingLimit(input.valueAsNumber))
  choosingLimit.value = false
  if (data.value) input.value = String(data.value.dailyLimit)
}
onMounted(() => refresh().catch((e: Error) => { error.value = e.message }))
</script>
<style scoped>
.policy-number { color:var(--a-ink); font-size:13px; font-variant-numeric:tabular-nums; }
.policy-limit { width:6em; }
</style>
