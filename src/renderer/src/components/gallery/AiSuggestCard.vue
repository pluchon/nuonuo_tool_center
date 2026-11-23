<template>
  <!-- 诺诺的建议：每项有采用 ✓ 和不要 ✕，右上角“全部采用” -->
  <div v-if="items.length" class="sugg">
    <div class="sugg__head">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" fill="var(--a)" /></svg>
      <span class="sugg__title">诺诺的建议</span>
      <button v-if="items.some((item) => item.kind !== 'r18Review')" class="sugg__all" type="button" :disabled="busy" @click="acceptAll">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>全部采用
      </button>
    </div>
    <div v-for="g in items" :key="g.key" class="sugg__row">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="icons[g.kind]" /></svg>
      <span class="sugg__kind">{{ kinds[g.kind] }}</span>
      <span class="sugg__val">{{ g.value }}</span>
      <span v-if="g.isNew" class="sugg__new">新建</span>
      <button class="sugg__ok" type="button" :aria-label="g.kind === 'r18Review' ? '保留 R-18' : '采用'" :disabled="busy" @click="decide(g.key, true)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </button>
      <button class="sugg__no" type="button" :aria-label="g.kind === 'r18Review' ? '取消 R-18' : '不要'" :disabled="busy" @click="decide(g.key, false)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
      </button>
    </div>
  </div>
</template>

<script lang="ts" src="./AiSuggestCard.ts"></script>
<style lang="scss" scoped src="./AiSuggestCard.scss"></style>
