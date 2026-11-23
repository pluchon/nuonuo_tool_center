<template>
  <Transition name="right-panel">
    <div v-show="open" id="right-panel" class="right-panel" :inert="!open">
      <slot />
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{ open: boolean }>()
</script>

<style scoped lang="scss">
.right-panel {
  flex: none;
  width: 300px;
  min-height: 0;
  display: flex;
}

.right-panel-enter-active,
.right-panel-leave-active {
  transition: transform 150ms ease-out, opacity 150ms ease-out;
}

// 退出时立即释放网格列宽，整段动画只移动面板，避免每一帧重新排布图片。
.right-panel-leave-active {
  position: absolute;
  inset: 0 0 0 auto;
  pointer-events: none;
}

.right-panel-enter-from,
.right-panel-leave-to {
  opacity: 0;
  transform: translateX(10px);
}

@media (prefers-reduced-motion: reduce) {
  .right-panel-enter-active, .right-panel-leave-active { transition: none; }
}
</style>
