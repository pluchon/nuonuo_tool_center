<template>
  <slot :pageImages="pageImages" />
  <nav v-if="pages > 1" class="result-pages" aria-label="搜索结果分页">
    <button type="button" aria-label="首页" :disabled="current === 1" @click="page = 1">«</button>
    <button type="button" aria-label="上一页" :disabled="current === 1" @click="page = current - 1">‹</button>
    <span aria-live="polite">{{ current }} / {{ pages }}</span>
    <button type="button" aria-label="下一页" :disabled="current === pages" @click="page = current + 1">›</button>
    <button type="button" aria-label="末页" :disabled="current === pages" @click="page = pages">»</button>
  </nav>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { GalleryItemVO } from '@shared/api'

const props = defineProps<{ images: GalleryItemVO[] }>()
defineSlots<{ default(props: { pageImages: GalleryItemVO[] }): unknown }>()
const pageSize = 24
const page = ref(1)
const pages = computed(() => Math.ceil(props.images.length / pageSize))
const current = computed(() => Math.max(1, Math.min(page.value, pages.value)))
const pageImages = computed(() => props.images.slice((current.value - 1) * pageSize, current.value * pageSize))
</script>

<style scoped lang="scss">
.result-pages {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--c-i-6E6280);
  font-size: 12px;
  font-variant-numeric: tabular-nums;

  span { margin: 0 6px; }

  button {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  button:hover:enabled { background: var(--a-soft); color: var(--a-ink); }
  button:disabled { opacity: 0.35; cursor: default; }
}
</style>
