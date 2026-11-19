<template>
  <div class="filter-bar">
    <label class="filter-bar__search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      <span class="filter-bar__sr">搜索</span>
      <input class="filter-bar__input" :value="draft" :placeholder="placeholder" @input="onInput" @keydown.esc.stop="clearSearch" />
      <button v-if="draft" class="filter-bar__clear" type="button" aria-label="清空搜索" @click="clearSearch">✕</button>
    </label>

    <div v-if="!gallery.nameOnly" ref="sortRef" class="filter-bar__dd">
      <button class="filter-bar__btn" :class="{ 'filter-bar__btn--open': sortOpen }" type="button" :aria-expanded="sortOpen" @click="sortOpen = !sortOpen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-i-3F8F7B)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        {{ sortLabel }}
      </button>
      <div v-if="sortOpen" class="filter-bar__pop" role="menu">
        <span class="filter-bar__arrow" aria-hidden="true" />
        <button
          v-for="o in sortOptions"
          :key="o.key"
          class="filter-bar__opt"
          :class="{ 'filter-bar__opt--on': o.key === gallery.sort }"
          type="button"
          role="menuitemradio"
          :aria-checked="o.key === gallery.sort"
          @click="pickSort(o.key)"
        >
          <span>{{ o.label }}</span><span>{{ o.key === gallery.sort ? '✓' : '' }}</span>
        </button>
      </div>
    </div>

    <button v-if="showR18" class="filter-bar__r18" :class="{ 'filter-bar__r18--on': gallery.onlyR18 }" type="button" :aria-pressed="gallery.onlyR18" @click="toggleR18">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="3" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
      R-18
    </button>

    <template v-if="showHereOnly">
      <span class="filter-bar__sep" aria-hidden="true" />
      <button class="filter-bar__here" :class="{ 'filter-bar__here--on': gallery.onlyHere }" type="button" role="switch" :aria-checked="gallery.onlyHere" @click="toggleHere">
        <span class="filter-bar__box" aria-hidden="true">{{ gallery.onlyHere ? '✓' : '' }}</span>仅当前目录(不含子目录)
      </button>
    </template>
  </div>

  <!-- 已选条件和图片数（只按名字搜的视图不放这一行） -->
  <div v-if="!gallery.nameOnly" class="filter-chips">
    <div class="filter-chips__list nn-noscroll">
      <span v-for="c in chips" :key="c.key" class="filter-chips__chip" :class="`filter-chips__chip--${c.tone}`">
        <span class="filter-chips__hole" aria-hidden="true" />
        <span class="filter-chips__label" :title="c.kind">{{ c.label }}</span>
        <button class="filter-chips__x" type="button" aria-label="去掉这个筛选" @click="c.remove">✕</button>
      </span>
    </div>
    <span class="filter-chips__count" title="筛选出的图片">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
      <span class="filter-chips__bar" aria-hidden="true" />
      <span class="filter-chips__num">{{ gallery.items.length.toLocaleString('zh-CN') }}</span>张
    </span>
  </div>
  <div v-else class="filter-chips__gap" aria-hidden="true" />
</template>

<script lang="ts" src="./FilterBar.ts"></script>
<style lang="scss" scoped src="./FilterBar.scss"></style>
