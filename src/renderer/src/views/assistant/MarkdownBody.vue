<template>
  <div class="markdown-body" v-html="html" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from './markdown'
const props = defineProps<{ text: string }>()
const html = computed(() => renderMarkdown(props.text))
</script>

<style scoped lang="scss">
.markdown-body {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
  user-select: text;
  :deep(> :first-child) { margin-top: 0; }
  :deep(> :last-child) { margin-bottom: 0; }
  :deep(p), :deep(ul), :deep(ol), :deep(blockquote), :deep(pre) { margin: .55em 0; }
  :deep(ul), :deep(ol) { padding-inline-start: 1.65em; }
  :deep(h1), :deep(h2), :deep(h3) { line-height: 1.4; margin: .85em 0 .4em; }
  :deep(h1) { font-size: 1.35em; }
  :deep(h2) { font-size: 1.2em; }
  :deep(h3) { font-size: 1.08em; }
  :deep(blockquote) { padding-left: .8em; border-left: 3px solid var(--a-line2); }
  :deep(code) { font: .92em/1.55 Consolas, monospace; background: var(--a08); border-radius: 4px; padding: .1em .28em; }
  :deep(pre) { padding: .8em 1em; border: 1px solid var(--a-line2); border-radius: 9px; overflow: auto; background: var(--a08); }
  :deep(pre code) { white-space: pre; background: none; padding: 0; }
  :deep(table) { display: block; overflow-x: auto; border-collapse: collapse; }
  :deep(td), :deep(th) { padding: .25em .55em; border: 1px solid var(--a-line2); }
}
</style>
