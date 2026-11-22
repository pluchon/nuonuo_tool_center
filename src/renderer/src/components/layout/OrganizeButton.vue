<template>
  <!-- 底栏“一键整理”：空闲时点了先估算再确认（本地分级在跑时变灰、点不了）；方案好了点开方案；进行中点了问要不要停 -->
  <button
    class="organize"
    :class="{ 'organize--busy': busy, 'organize--ready': org.phase === 'PLAN_READY' }"
    type="button"
    :disabled="waiting"
    :title="waiting ? '本地分级判完才能整理' : undefined"
    @click="org.click()"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 13l2 2 4-4" />
    </svg>
    {{ label }}
    <span v-if="org.phase === 'PLAN_READY'" class="organize__dot" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <OrganizeDialog />
  </Teleport>
</template>

<script lang="ts" src="./OrganizeButton.ts"></script>
<style lang="scss" scoped src="./OrganizeButton.scss"></style>
