<template>
  <div class="batch-panel">
    <div class="batch-panel__head">
      <span class="batch-panel__title">已选 <span class="batch-panel__num">{{ gallery.selected.length }}</span> 张</span>
      <button
        class="batch-panel__bin"
        type="button"
        :aria-label="`删除选中的 ${gallery.selected.length} 张`"
        :title="`删除选中的 ${gallery.selected.length} 张（进系统回收站）`"
        @click="gallery.askDelete()"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
      </button>
    </div>

    <div class="batch-panel__thumbs">
      <span v-for="t in thumbs" :key="t.imageId" class="batch-panel__thumb">
        <img v-if="t.thumb === 'READY'" :src="thumbUrl(t.hash)" :class="{ 'batch-panel__pic--masked': t.isR18 && blurR18 }" alt="" draggable="false" />
      </span>
      <span v-if="more > 0" class="batch-panel__thumb batch-panel__thumb--more">+{{ more }}</span>
    </div>

    <div class="batch-panel__block">
      <div class="batch-panel__row-head">
        <span class="batch-panel__label">共同标签</span>
        <span class="batch-panel__label">{{ gallery.commonTags.length }} 个</span>
      </div>
      <div class="batch-panel__box">
        <div class="batch-panel__list">
          <span v-for="t in gallery.commonTags" :key="t.id" class="batch-panel__tag" :title="categoryName(t.categoryId)">
            <span class="batch-panel__dot" :style="{ background: colorOf(t.categoryId).dot }" aria-hidden="true" />{{ t.name }}
            <button class="batch-panel__x" type="button" aria-label="从这些图上移除" :disabled="busy" @click="onRemove(t.id)">✕</button>
          </span>
          <span v-if="gallery.commonTags.length === 0" class="batch-panel__none">没有共同标签</span>
        </div>
        <label class="batch-panel__add">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span class="batch-panel__sr">给这些图加标签</span>
          <input class="batch-panel__input" placeholder="给这些图加标签，回车" :value="draft" :readonly="busy" @input="onInput" @keydown.enter="onEnter" />
        </label>
      </div>
    </div>

    <div class="batch-panel__r18">
      <button class="batch-panel__r18-btn batch-panel__r18-btn--on" type="button" :disabled="busy" @click="onR18(true)">全部标 R-18</button>
      <button class="batch-panel__r18-btn" type="button" :disabled="busy" @click="onR18(false)">全部取消 R-18</button>
    </div>
  </div>
</template>

<script lang="ts" src="./BatchPanel.ts"></script>
<style lang="scss" scoped src="./BatchPanel.scss"></style>
