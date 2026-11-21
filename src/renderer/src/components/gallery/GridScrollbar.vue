<template>
  <div
    v-show="visible"
    class="grid-scroll"
    :class="{ 'grid-scroll--active': active, 'grid-scroll--drag': dragging }"
    role="scrollbar"
    aria-orientation="vertical"
    aria-label="滚动图片列表"
    :aria-valuenow="percent"
    aria-valuemin="0"
    aria-valuemax="100"
    @pointerdown="onRailDown"
    @wheel="onWheel"
    @pointerenter="hover = true"
    @pointerleave="hover = false"
  >
    <span class="grid-scroll__rail" aria-hidden="true" />
    <span
      class="grid-scroll__thumb"
      :style="{ height: `${thumbH}px`, transform: `translateY(${thumbY}px)` }"
      @pointerdown.stop="onThumbDown"
      @pointermove="onThumbMove"
      @pointerup="onThumbUp"
      @pointercancel="onThumbUp"
    />
    <span
      v-if="label"
      class="grid-scroll__bubble"
      :class="{ 'grid-scroll__bubble--on': bubbleOn }"
      :style="{ transform: `translateY(${thumbY + thumbH / 2}px)` }"
      aria-hidden="true"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l2.3 8.2 8.2 2.3-8.2 2.3-2.3 8.2-2.3-8.2L1.5 12l8.2-2.3z" /></svg>{{ label }}
    </span>
  </div>
</template>

<script lang="ts" src="./GridScrollbar.ts"></script>
<style lang="scss" scoped src="./GridScrollbar.scss"></style>
