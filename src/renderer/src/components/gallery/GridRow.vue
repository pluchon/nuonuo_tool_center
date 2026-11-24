<template>
  <div class="image-grid__row" :data-row-key="rowKey">
    <div v-if="!virtual || visibleRows.has(rowKey)" class="image-grid__tiles"><slot /></div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ rowKey: string; virtual: boolean; visibleRows: ReadonlySet<string> }>()
</script>

<style scoped>
.image-grid__tiles {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 8px;
}
</style>
