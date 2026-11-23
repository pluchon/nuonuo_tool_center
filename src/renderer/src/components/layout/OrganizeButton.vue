<template>
  <!-- 空闲时打开估算确认框，已有方案时进入复核，正在整理时显示停止确认。 -->
  <button
    class="organize"
    :class="{ 'organize--ready': org.phase === 'PLAN_READY', 'organize--waiting': waiting }"
    type="button"
    :aria-disabled="waiting || org.phase === 'ASSIGNING' ? 'true' : undefined"
    @click="org.click()"
  >
    <svg v-if="busy" class="organize__spinner" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <circle cx="7" cy="7" r="5" opacity="0.25" />
      <path d="M7 2a5 5 0 0 1 5 5" stroke-linecap="round" />
    </svg>
    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
