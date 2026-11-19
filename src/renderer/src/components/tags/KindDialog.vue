<template>
  <Transition name="nn-dlg">
    <div v-if="open" class="kind-dlg" @click="$emit('close')">
      <div class="kind-dlg__frame nn-dlg-panel" role="dialog" aria-modal="true" aria-label="标签分类" @click.stop>
        <div class="kind-dlg__card">
          <div class="kind-dlg__head">
            <h2 class="kind-dlg__title">标签分类</h2>
            <button class="kind-dlg__close" type="button" aria-label="关闭" @click="$emit('close')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
            </button>
          </div>
          <div ref="listRef" class="kind-dlg__list">
            <div
              v-for="r in rows"
              :key="r.id"
              class="kind-dlg__row"
              :style="{ background: r.color.bg, borderColor: r.over ? 'var(--c-b-A23D62)' : r.color.line }"
            >
              <span class="kind-dlg__dot" :style="{ background: r.color.dot }" aria-hidden="true" />
              <input
                class="kind-dlg__input"
                :data-id="r.id"
                aria-label="分类名"
                :value="r.draft"
                :style="{ color: r.color.ink }"
                @input="onInput(r.id, $event)"
                @keydown.enter="onEnter($event)"
                @keydown.esc.stop="onEsc(r.id, $event)"
                @blur="commit(r.id)"
              />
              <span class="kind-dlg__count" :style="{ color: r.color.ink, '--hole': r.color.bg }">{{ r.used }} 个标签</span>
              <button
                class="kind-dlg__del"
                :class="{ 'kind-dlg__del--off': !r.canDel }"
                type="button"
                aria-label="删除分类"
                :aria-disabled="!r.canDel"
                :title="r.used > 0 ? '还有标签在用，先把它们改到别的分类' : '删除分类'"
                @click="remove(r.id, r.canDel)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
              </button>
            </div>
          </div>
          <button class="kind-dlg__add" type="button" :disabled="busy" @click="add">＋ 新增分类</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script lang="ts" src="./KindDialog.ts"></script>
<style lang="scss" scoped src="./KindDialog.scss"></style>
