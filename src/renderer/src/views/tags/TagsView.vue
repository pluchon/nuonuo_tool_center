<template>
  <div class="tags-view">
    <section class="tags-view__main">
      <div class="tags-view__bar">
        <label class="tags-view__search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <span class="tags-view__sr">搜索标签</span>
          <input v-model="query" class="tags-view__input" placeholder="搜标签名或别名" />
        </label>
        <button class="tags-view__kinds" type="button" aria-label="管理分类" @click="kindOpen = true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></svg>
        </button>
        <button class="tags-view__new" type="button" @click="startCreate">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>新建标签
        </button>
      </div>

      <div class="tags-view__list">
        <div v-for="g in groups" :key="g.id" class="tags-view__card" :class="{ 'tags-view__card--pal': palFor === g.id }">
          <div class="tags-view__head">
            <span class="tags-view__kind"><span class="tags-view__dot" :style="{ background: g.color.dot }" aria-hidden="true" />{{ g.name }}</span>
            <span class="tags-view__total" :style="{ '--shape-bg': `color-mix(in srgb, ${g.color.dot} 18%, transparent)`, color: g.color.ink }">{{ g.total }} 个</span>
            <span class="tags-view__pal-wrap" data-pal>
              <button class="tags-view__pal" type="button" aria-label="换分类颜色" :style="{ color: g.color.dot }" @click="togglePal(g.id)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.4-9-7.4z" /><circle cx="7.5" cy="10.5" r="1.2" /><circle cx="11" cy="7" r="1.2" /><circle cx="15.5" cy="8" r="1.2" /></svg>
              </button>
              <div v-if="palFor === g.id" class="tags-view__swatches" role="listbox" aria-label="分类颜色">
                <span class="tags-view__swatch-arrow" aria-hidden="true" />
                <button
                  v-for="w in g.swatches"
                  :key="w.n"
                  class="tags-view__swatch"
                  :class="{ 'tags-view__swatch--mine': w.mine }"
                  type="button"
                  role="option"
                  :aria-selected="w.mine"
                  :style="{ background: w.dot, '--ring': w.dot }"
                  @click="pickColor(g.id, w.n)"
                />
              </div>
            </span>
          </div>
          <div class="tags-view__tags">
            <button
              v-for="t in g.tags"
              :key="t.tag.id"
              class="tags-view__tag"
              :class="{ 'tags-view__tag--on': t.on }"
              type="button"
              :style="t.style"
              @click="pick(t.tag.id)"
            >
              {{ t.tag.name }}<span class="tags-view__count" :style="{ background: t.countBg }">{{ t.tag.count }}</span>
            </button>
            <span v-if="g.tags.length === 0" class="tags-view__empty">没有匹配的标签</span>
          </div>
        </div>
      </div>
    </section>

    <TagPanel
      :tag="creating ? null : selected"
      :creating="creating || !selected"
      :default-category-id="defaultCategoryId"
      @saved="onSaved"
      @cancel="creating = false"
      @delete="askDelete"
      @view-images="viewImages"
    />

    <KindDialog :open="kindOpen" @close="kindOpen = false" />
    <ConfirmDialog
      :open="!!deleting"
      :title="deleting ? `删除标签「${deleting.name}」？` : ''"
      :busy="deleteBusy"
      @ok="confirmDelete"
      @cancel="deleting = null"
    />
  </div>
</template>

<script lang="ts" src="./TagsView.ts"></script>
<style lang="scss" scoped src="./TagsView.scss"></style>
