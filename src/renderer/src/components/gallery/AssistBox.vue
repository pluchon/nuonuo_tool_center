<template>
  <div class="assist">
    <div class="assist__head">
      <span class="assist__label">其他 AI 辅助整理</span>
      <button class="assist__look" type="button" :disabled="busy || !text.trim()" @click="handOff">
        <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" fill="currentColor" /></svg>
        {{ busy ? '整理中' : text.trim() ? '交给诺诺整理' : '诺诺在等' }}
      </button>
    </div>
    <div class="assist__box">
      <label class="assist__field">
        <span class="assist__sr">贴入其他 AI 回复的结果</span>
        <textarea v-model="text" class="assist__input" rows="4" placeholder="粘贴其他 AI 的回复" />
      </label>
      <button class="assist__copy" :class="{ 'assist__copy--ok': copied }" type="button" :aria-label="copied ? '已复制提示词' : '复制给其他 AI 的提示词'" @click="copyPrompt">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="copied ? checkPath : copyPath" /></svg>
      </button>
    </div>
  </div>
</template>

<script lang="ts" src="./AssistBox.ts"></script>
<style lang="scss" scoped src="./AssistBox.scss"></style>
