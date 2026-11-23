<template>
  <div class="image-grid__row" :data-row-key="rowKey">
    <slot v-if="!virtual || visibleRows.has(rowKey)" />
  </div>
</template>

<script setup lang="ts">
// 每行只订阅自己的可见状态，滚动时无需重新渲染整个图库。
defineProps<{ rowKey: string; virtual: boolean; visibleRows: ReadonlySet<string> }>()
</script>
