<template>
  <dialog ref="dialog" class="file-preview" :aria-label="title" aria-modal="true" @close="emit('close')" @click="dismissBackdrop">
    <header>
      <span class="file-preview__mark" aria-hidden="true">{{ file.kind === 'markdown' ? 'MD' : '▧' }}</span>
      <h2>{{ title }}</h2>
      <button type="button" aria-label="关闭预览" autofocus @click="dialog?.close()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <div class="file-preview__body nn-thin" tabindex="0">
      <MarkdownBody v-if="file.kind === 'markdown'" :text="file.text" />
      <img v-else :src="file.dataUrl" :alt="title" />
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AiAttachment } from '@shared/api'
import MarkdownBody from './MarkdownBody.vue'
const props = defineProps<{ file: AiAttachment }>()
const emit = defineEmits<{ close: [] }>()
const title = computed(() => props.file.name || '图片')
const dialog = ref<HTMLDialogElement>()
onMounted(() => dialog.value?.showModal())
function dismissBackdrop(event: MouseEvent) {
  if (event.target !== dialog.value) return
  const box = dialog.value.getBoundingClientRect()
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.value.close()
}
</script>

<style scoped lang="scss">
.file-preview {
  box-sizing: border-box;
  width: min(620px, calc(100vw - 48px));
  height: min(470px, calc(100dvh - 64px));
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--a-line2);
  border-radius: 18px;
  background: var(--ai-menu-bg);
  color: var(--c-i-2E2440);
  box-shadow: var(--ai-menu-shadow);
  &[open] { display: flex; flex-direction: column; }
  &::backdrop { background: rgb(24 18 33 / 38%); backdrop-filter: blur(4px); }
  header { display: flex; align-items: center; gap: 12px; padding: 15px 18px; border-bottom: 1px solid var(--a-line2); }
  h2 { flex: 1; min-width: 0; margin: 0; text-align: left; font-size: 16px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
  &__mark { padding: 6px; background: var(--a-soft); color: var(--a-ink); border-radius: 7px; font: 700 12px Consolas, monospace; }
  button { display: grid; place-items: center; padding: 7px; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
  button:hover { background: var(--a08); }
  &__body { flex: 1; min-height: 0; overflow: auto; padding: 18px 24px; font-size: 14px; line-height: 1.7; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; }
}
</style>
