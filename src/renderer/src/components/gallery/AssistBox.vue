<template>
  <!-- 其他 AI 辅助整理：复制提示词连同图片发给你的 AI，把它回的 json 代码块贴回来，交给诺诺整理 -->
  <div class="assist">
    <div class="assist__head">
      <span class="assist__label">其他 AI 辅助整理</span>
      <!-- 老图不会自动排队：手动让诺诺看一张（R-18 图不上云，不显示） -->
      <button v-if="!r18" class="assist__look" type="button" @click="look.now(imageId)">
        <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" fill="var(--a)" /></svg>让诺诺看看
      </button>
    </div>
    <div class="assist__box" :class="{ 'assist__box--ok': count > 0, 'assist__box--bad': bad }">
      <label class="assist__field">
        <span class="assist__sr">贴入其他 AI 回复的结果</span>
        <textarea v-model="text" class="assist__input" rows="4" placeholder="辅助提示词给你的AI" />
      </label>
      <button class="assist__copy" :class="{ 'assist__copy--ok': copied }" type="button" :aria-label="copied ? '已复制提示词' : '复制给其他 AI 的提示词'" @click="copyPrompt">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="copied ? checkPath : copyPath" /></svg>
      </button>
    </div>
    <div v-if="count > 0" class="assist__found">
      <span class="assist__count">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>识别到 {{ count }} 条
      </span>
      <button class="assist__hand" type="button" :disabled="busy" @click="handOff">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" fill="var(--a)" /></svg>交给诺诺整理
      </button>
    </div>
    <span v-if="bad" class="assist__bad">没找到 json 代码块</span>
  </div>
</template>

<script lang="ts" src="./AssistBox.ts"></script>
<style lang="scss" scoped src="./AssistBox.scss"></style>
