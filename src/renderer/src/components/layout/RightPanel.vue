<template>
  <div id="right-panel" class="right-panel" :class="{ 'right-panel--closed': !open }" :style="panelStyle" :inert="!open">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { PANEL_WIDTH, PANEL_GAP } from '@/utils/gridLayout'
const panelStyle = { '--panel-width': PANEL_WIDTH + 'px', '--panel-gap': PANEL_GAP + 'px' }
defineProps<{ open: boolean }>()
</script>

<style scoped>
.right-panel {
  display: flex;
  flex: none;
  width: var(--panel-width);
  min-height: 0;
  margin-inline-start: var(--panel-gap);
  overflow: clip;
  transition: width 260ms ease-in-out, margin-inline-start 260ms ease-in-out;
}
.right-panel--closed {
  width: 0;
  margin-inline-start: 0;
}
@media (prefers-reduced-motion: reduce) {
  .right-panel { transition: none; }
}
</style>
