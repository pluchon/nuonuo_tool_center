<template>
  <div class="tag-editor">
    <div class="tag-editor__head">
      <span class="tag-editor__label">图片好标签</span>
      <span class="tag-editor__count" :class="{ 'tag-editor__count--full': full }">{{ tags.length }} / {{ max }}</span>
    </div>
    <div class="tag-editor__box">
      <div class="tag-editor__list">
        <span v-for="t in tags" :key="t.id" class="tag-editor__tag">
          <span class="tag-editor__dot" :style="{ background: colorOf(t.categoryId).dot }" aria-hidden="true" />{{ t.name }}
          <button class="tag-editor__x" type="button" aria-label="移除标签" :disabled="busy" @click="onRemove(t.id)">✕</button>
        </span>
      </div>
      <div ref="addRef" class="tag-editor__add">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        <span class="tag-editor__kind-wrap">
          <button
            class="tag-editor__kind"
            :class="{ 'tag-editor__kind--locked': !!exact }"
            type="button"
            aria-haspopup="listbox"
            :aria-expanded="kindOpen"
            @click="toggleKind"
          >
            <span class="tag-editor__dot" :style="{ background: colorOf(shownCategoryId).dot }" aria-hidden="true" />{{ categoryName(shownCategoryId) }}<span v-if="!exact" class="tag-editor__caret">▾</span>
          </button>
          <Transition name="nn-pop">
            <div v-if="kindOpen" class="tag-editor__pop tag-editor__pop--kind" role="listbox" aria-label="新标签的分类">
              <span class="tag-editor__arrow" aria-hidden="true" />
              <button
                v-for="c in tagsStore.categories"
                :key="c.id"
                class="tag-editor__opt"
                :style="c.id === shownCategoryId ? { background: colorOf(c.id).bg, color: colorOf(c.id).ink } : undefined"
                type="button"
                role="option"
                :aria-selected="c.id === shownCategoryId"
                @click="pickKind(c.id)"
              >
                <span class="tag-editor__dot" :style="{ background: colorOf(c.id).dot }" aria-hidden="true" />
                <span class="tag-editor__opt-label">{{ c.name }}</span><span>{{ c.id === shownCategoryId ? '✓' : '' }}</span>
              </button>
            </div>
          </Transition>
        </span>
        <input
          class="tag-editor__input"
          aria-label="添加标签"
          :placeholder="full ? `已满 ${max} 个，先删掉一个` : '输入标签，回车添加'"
          :readonly="full || busy"
          :value="draft"
          @input="onInput"
          @keydown.enter="onEnter"
          @keydown.esc.stop="!$event.isComposing && $event.keyCode !== 229 && (draft = '')"
        />
        <Transition name="nn-pop">
          <div v-if="suggestions.length > 0 && !kindOpen" class="tag-editor__pop tag-editor__pop--sugg" role="listbox" aria-label="匹配的标签">
            <button v-for="s in suggestions" :key="s.tag.id" class="tag-editor__sugg" type="button" role="option" @click="pick(s.tag.name)">
              <span class="tag-editor__dot" :style="{ background: colorOf(s.tag.categoryId).dot }" aria-hidden="true" />
              <span class="tag-editor__sugg-name">{{ s.tag.name }}</span>
              <span class="tag-editor__sugg-alias">{{ s.alias ? `别名 ${s.alias}` : '' }}</span>
              <span class="tag-editor__sugg-count">{{ s.tag.count }} 张</span>
            </button>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<script lang="ts" src="./TagEditor.ts"></script>
<style lang="scss" scoped src="./TagEditor.scss"></style>
