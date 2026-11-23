<template>
  <div class="attachment-card">
    <img v-if="file.kind === 'image'" class="attachment-card__preview" :src="file.dataUrl" alt="" draggable="false" />
    <span v-else class="attachment-card__icon" aria-label="Markdown 文件">MD</span>
    <div class="attachment-card__info">
      <strong v-if="file.name" class="attachment-card__name" :title="file.name">{{ file.name }}</strong>
      <span v-if="file.kind === 'image'" class="attachment-card__type">{{ fileType }}</span>
    </div>
    <button v-if="removable" type="button" class="attachment-card__remove" :aria-label="`移除附件 ${file.name || '图片'}`" @click="$emit('remove')">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AiAttachment } from '@shared/api'

const props = defineProps<{ file: AiAttachment; removable?: boolean }>()
defineEmits<{ remove: [] }>()
const fileType = computed(() => props.file.kind === 'markdown'
  ? ''
  : props.file.mimeType.replace(/^image\//i, '').split('+')[0].toUpperCase())
</script>

<style scoped lang="scss">
.attachment-card {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  max-width: min(100%, 288px);
  box-sizing: border-box;
  gap: 10px;
  padding: 5px 10px 5px 5px;
  border: 1px solid var(--a-line2);
  border-radius: 12px;
  background: var(--look-field-bg);
  color: var(--c-i-3B3047);
}

.attachment-card__icon, .attachment-card__preview {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background: var(--a-soft);
}

.attachment-card__icon {
  display: grid;
  place-items: center;
  color: var(--a-ink);
  font: 700 14px/1 ui-monospace, Consolas, monospace;
  letter-spacing: 0.04em;
  box-shadow: inset 0 0 0 1px var(--a-line2);
}

.attachment-card__preview { object-fit: cover; }
.attachment-card__info { display: grid; gap: 3px; min-width: 0; }
.attachment-card__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.attachment-card__type { font-size: 11px; color: var(--c-i-6E6280); }
.attachment-card__remove {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.attachment-card__remove:hover { background: var(--a08); }
</style>
