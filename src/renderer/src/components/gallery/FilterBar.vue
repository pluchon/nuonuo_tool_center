<template>
  <div class="filter-bar">
    <label class="filter-bar__search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      <span class="filter-bar__sr">搜索</span>
      <input class="filter-bar__input" :value="draft" :placeholder="placeholder" @input="onInput" @keydown.esc.stop="clearSearch" />
      <button v-if="draft" class="filter-bar__clear" type="button" aria-label="清空搜索" @click="clearSearch">✕</button>
    </label>

    <!-- 标签 -->
    <div v-if="showTags" class="filter-bar__dd" data-dd="tag">
      <button class="filter-bar__btn" :class="{ 'filter-bar__btn--open': open === 'tag' || gallery.tagIds.length > 0 }" type="button" :aria-expanded="open === 'tag'" @click="toggle('tag')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-i-C25B85)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><path d="M8 8h.01" /></svg>
        标签<span class="filter-bar__badge filter-bar__badge--pink">{{ gallery.tagIds.length }}</span>
      </button>
      <Transition name="nn-pop">
        <div v-if="open === 'tag'" class="filter-bar__pop filter-bar__pop--list">
          <span class="filter-bar__arrow" aria-hidden="true" />
          <div class="filter-bar__pop-head"><span>选标签</span><span :class="{ 'filter-bar__full': gallery.tagIds.length >= max }">{{ gallery.tagIds.length }} / {{ max }}</span></div>
          <div class="filter-bar__scroll">
            <button v-for="t in tagOptions" :key="t.id" class="filter-bar__check" :class="{ 'filter-bar__check--on': gallery.tagIds.includes(t.id) }" type="button" @click="toggleTag(t.id)">
              <span class="filter-bar__box" :class="{ 'filter-bar__box--full': gallery.tagIds.length >= max }" aria-hidden="true">{{ gallery.tagIds.includes(t.id) ? '✓' : '' }}</span>
              <span class="filter-bar__check-label">{{ t.name }}</span><span class="filter-bar__check-note" :style="{ color: colorOf(t.categoryId).ink }">{{ categoryName(t.categoryId) }}</span>
            </button>
            <span v-if="tagOptions.length === 0" class="filter-bar__empty">还没有标签</span>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 目录 -->
    <div v-if="dirOptions.length > 0 && showDirs" class="filter-bar__dd" data-dd="dir">
      <button class="filter-bar__btn" :class="{ 'filter-bar__btn--open': open === 'dir' || gallery.dirs.length > 0 }" type="button" :aria-expanded="open === 'dir'" @click="toggle('dir')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        目录<span class="filter-bar__badge filter-bar__badge--accent">{{ gallery.dirs.length }}</span>
      </button>
      <Transition name="nn-pop">
        <div v-if="open === 'dir'" class="filter-bar__pop filter-bar__pop--list">
          <span class="filter-bar__arrow" aria-hidden="true" />
          <div class="filter-bar__pop-head"><span>选目录</span><span :class="{ 'filter-bar__full': gallery.dirs.length >= max }">{{ gallery.dirs.length }} / {{ max }}</span></div>
          <div class="filter-bar__scroll">
            <button v-for="d in dirOptions" :key="d.key" class="filter-bar__check" :class="{ 'filter-bar__check--on': dirOn(d.key) }" type="button" @click="toggleDir(d)">
              <span class="filter-bar__box" :class="{ 'filter-bar__box--full': gallery.dirs.length >= max }" aria-hidden="true">{{ dirOn(d.key) ? '✓' : '' }}</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" :stroke="d.ink" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="filter-bar__icon"><path :d="d.icon" /></svg>
              <span class="filter-bar__check-label">{{ d.label }}</span><span class="filter-bar__check-note">{{ d.count }}</span>
            </button>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 更多 -->
    <div v-if="showMore" class="filter-bar__dd" data-dd="more">
      <button class="filter-bar__btn" :class="{ 'filter-bar__btn--open': open === 'more' || moreCount > 0 }" type="button" :aria-expanded="open === 'more'" @click="toggle('more')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-i-4A86C2)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></svg>
        更多<span class="filter-bar__badge filter-bar__badge--blue">{{ moreCount }}</span>
      </button>
      <Transition name="nn-pop">
        <div v-if="open === 'more'" class="filter-bar__pop filter-bar__pop--more">
          <span class="filter-bar__arrow" aria-hidden="true" />
          <div class="filter-bar__pop-head"><span>更多筛选</span><button class="filter-bar__reset" type="button" @click="clearMore">清空</button></div>
          <div v-for="sec in moreSections" :key="sec.key" class="filter-bar__sec">
            <span class="filter-bar__sec-title">{{ sec.title }}</span>
            <div class="filter-bar__sec-opts">
              <button v-for="o in sec.opts" :key="o.value" class="filter-bar__pill" :class="{ 'filter-bar__pill--on': moreOn(sec.key, o.value) }" type="button" @click="toggleMore(sec.key, o.value)">{{ o.label }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 排序 -->
    <div v-if="!gallery.nameOnly" class="filter-bar__dd" data-dd="sort">
      <button class="filter-bar__btn" :class="{ 'filter-bar__btn--open': open === 'sort' }" type="button" :aria-expanded="open === 'sort'" @click="toggle('sort')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-i-3F8F7B)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        {{ sortLabel }}
      </button>
      <Transition name="nn-pop">
        <div v-if="open === 'sort'" class="filter-bar__pop filter-bar__pop--sort" role="menu">
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
      </Transition>
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
      <span v-for="c in chips" :key="c.key" class="filter-chips__chip" :style="{ background: c.bg, color: c.ink }">
        <span class="filter-chips__hole" aria-hidden="true" />
        <span class="filter-chips__label" :title="c.kind">{{ c.label }}</span>
        <button class="filter-chips__x" type="button" aria-label="去掉这个筛选" @click="c.remove">✕</button>
      </span>
    </div>
    <!-- 没有筛选条件时不显示筛选出的张数 -->
    <span v-if="chips.length > 0" class="filter-chips__count" title="筛选出的图片">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
      <span class="filter-chips__bar" aria-hidden="true" />
      <span class="filter-chips__num">{{ gallery.items.length.toLocaleString('zh-CN') }}</span>张
    </span>
  </div>
  <div v-else class="filter-chips__gap" aria-hidden="true" />
</template>

<script lang="ts" src="./FilterBar.ts"></script>
<style lang="scss" scoped src="./FilterBar.scss"></style>
