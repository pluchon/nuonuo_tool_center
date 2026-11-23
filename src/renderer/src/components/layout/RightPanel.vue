<template>
  <div v-show="shown" ref="panel" id="right-panel" class="right-panel" :inert="!open">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{ open: boolean; syncGrid?: () => Promise<void> }>()
const panel = ref<HTMLElement | null>(null)
const shown = ref(props.open)

watch(() => props.open, (open, _, onCleanup) => {
  const scope = panel.value?.parentElement
  if (open === shown.value) return
  if (!scope || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    shown.value = open
    void nextTick(() => props.syncGrid?.())
    return
  }
  const marked = new Set<HTMLElement>()
  const markVisible = () => {
    const grid = scope.querySelector('.image-grid')
    if (!grid) return
    const viewport = grid.getBoundingClientRect()
    for (const tile of grid.querySelectorAll<HTMLElement>('.tile[data-id]')) {
      const box = tile.getBoundingClientRect()
      if (box.bottom <= viewport.top || box.top >= viewport.bottom) continue
      tile.style.viewTransitionName = 'panel-tile-' + tile.dataset.id
      marked.add(tile)
    }
  }
  const root = document.documentElement
  root.classList.add('panel-motion')
  markVisible()
  let active = true
  const transition = document.startViewTransition(async () => {
    if (!active) return
    shown.value = open
    await nextTick()
    if (!active) return
    // 在新画面截取前按最终宽度排版一次，移动跨行的图片也沿用同一张快照。
    await props.syncGrid?.()
    if (active) markVisible()
  })
  const clear = () => {
    if (!active) return
    active = false
    root.classList.remove('panel-motion')
    for (const tile of marked) tile.style.removeProperty('view-transition-name')
  }
  onCleanup(() => { transition.skipTransition(); clear() })
  void transition.ready.catch(() => {})
  void transition.finished.then(clear, clear)
})
</script>

<style lang="scss">
.right-panel {
  flex: none;
  width: 300px;
  min-height: 0;
  display: flex;
}
:root.panel-motion {
  --panel-motion-duration: 300ms;
  --panel-motion-easing: ease-in-out;
  view-transition-name: none;
  .right-panel { view-transition-name: editing-panel; }
  .tags-view__main, .gallery__column > .filter-bar { view-transition-name: panel-controls; }
  .image-grid { view-transition-name: panel-grid; view-transition-group: contain; }
  &::view-transition-group-children(panel-grid) { overflow: clip; }
  &::view-transition { pointer-events: none; overflow: clip; }
  &::view-transition-group(*) {
    animation-duration: var(--panel-motion-duration);
    animation-timing-function: var(--panel-motion-easing);
  }
  &::view-transition-group(editing-panel) { z-index: 1; }
  // 位置和尺寸由 group 插值。共享元素只绘制新画面，否则文字和描边会重叠。
  &::view-transition-old(*) { opacity: 0; animation: none; }
  &::view-transition-new(*) { animation: none; mix-blend-mode: normal; }
  &::view-transition-old(*):only-child { opacity: 1; animation: revert; }
  &::view-transition-new(*):only-child { animation: revert; }
  &::view-transition-new(editing-panel):only-child { animation: panel-slide var(--panel-motion-duration) var(--panel-motion-easing) both; }
  // 缩略图可能稍后才完成移动，旧面板快照须保持隐藏直到整个过渡结束。
  &::view-transition-old(editing-panel):only-child { animation: panel-slide var(--panel-motion-duration) var(--panel-motion-easing) reverse both; }
}
@keyframes panel-slide {
  from { transform: translateX(100%); opacity: 0; }
  10% { opacity: 1; }
  to { transform: none; opacity: 1; }
}
</style>
