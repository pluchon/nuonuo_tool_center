<template>
  <div ref="box" class="bubble-editor" contenteditable="plaintext-only" role="textbox"
    aria-label="编辑消息内容" aria-multiline="true" @input="read" @compositionend="read" />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AI_TEXT_MAX } from '@shared/api'
const model = defineModel<string>({ required: true })
const box = ref<HTMLElement>()
function placeCaret(el: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
function read(event: Event) {
  if ((event as InputEvent).isComposing || !box.value) return
  const el = box.value
  const value = el.innerText.replace(/\r\n/g, '\n')
  const limited = Array.from(value).slice(0, AI_TEXT_MAX).join('')
  if (limited !== value) {
    el.textContent = limited
    placeCaret(el)
  }
  model.value = limited
}
onMounted(() => {
  const el = box.value!
  el.textContent = model.value
  el.focus({ preventScroll: true })
  placeCaret(el)
})
</script>

<style scoped>
.bubble-editor {
  width: fit-content;
  min-width: 1ch;
  min-height: 1lh;
  max-height: 30dvh;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  outline: none;
  cursor: text;
}
</style>
