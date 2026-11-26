<template>
  <nav class="side-nav nn-noscroll" aria-label="导航">
    <section v-for="sec in sections" :key="sec.title" class="side-nav__card" :aria-label="sec.title">
      <div class="side-nav__head">
        <span class="side-nav__dot" :style="{ background: sec.dot }" aria-hidden="true" />{{ sec.title }}
        <button
          v-if="sec.add"
          class="side-nav__add"
          type="button"
          :style="{ color: sec.dot }"
          :aria-label="sec.add.label"
          :disabled="sec.add.disabled"
          @click="sec.add.run"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <div class="side-nav__rows">
        <template v-for="row in sec.rows" :key="row.key">
          <div
            v-if="row.type === 'item'"
            class="side-nav__row"
            :class="{ 'side-nav__row--drop': gallery.dropKey === row.key }"
            @contextmenu="onContextMenu(row, $event)"
            @dragover="onDragOver(row, $event)"
            @dragleave="onDragLeave(row)"
            @drop="onDrop(row, $event)"
          >
            <span
              v-for="(g, i) in row.guides"
              :key="i"
              class="side-nav__guide"
              :style="{ left: g.left, top: g.top, height: g.height, width: g.width, borderBottomStyle: g.bottom ? 'solid' : 'none', borderRadius: g.radius }"
              aria-hidden="true"
            />
            <button
              class="side-nav__item"
              :class="{ 'side-nav__item--on': isActiveRow(row), 'side-nav__item--tree': row.tree }"
              :style="row.depth ? { marginLeft: `${row.depth * 14 + 2}px`, paddingLeft: '2px' } : undefined"
              type="button"
              :disabled="row.disabled"
              :aria-current="isActiveRow(row) ? 'page' : undefined"
              @click="onRowClick(row)"
            >
              <span
                v-if="row.tree"
                class="side-nav__caret"
                :class="{ 'side-nav__caret--open': row.expanded }"
                :style="{ visibility: row.hasChildren ? 'visible' : 'hidden' }"
                role="button"
                :aria-label="row.expanded ? '收起' : '展开'"
                :aria-expanded="row.expanded"
                @click="onToggle(row, $event)"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              </span>
              <svg
                class="side-nav__icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                :stroke="isActiveRow(row) ? 'var(--a-ink)' : row.ink"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path :d="row.icon" />
              </svg>
              <span class="side-nav__label" :style="row.labelInk ? { color: row.labelInk } : undefined">{{ row.label }}</span>
              <span class="side-nav__count" :style="row.countInk ? { color: row.countInk } : undefined">{{ row.count }}</span>
            </button>
          </div>

          <div v-else class="side-nav__edit-wrap">
            <span
              v-for="(g, i) in row.guides"
              :key="i"
              class="side-nav__guide"
              :style="{ left: g.left, top: g.top, height: g.height, width: g.width, borderBottomStyle: g.bottom ? 'solid' : 'none', borderRadius: g.radius }"
              aria-hidden="true"
            />
            <label
              class="side-nav__edit"
              :style="{ marginLeft: row.depth ? `${row.depth * 14 + 2}px` : '0px', borderColor: folders.draftOver ? 'var(--c-b-A23D62)' : row.ink }"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="row.ink" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="side-nav__icon">
                <path :d="row.icon" />
              </svg>
              <span class="side-nav__sr">目录名</span>
              <input
                class="side-nav__edit-input"
                :value="folders.draft"
                :placeholder="row.placeholder"
                :style="{ caretColor: row.ink }"
                @input="onDraft"
                @keydown="onDraftKey"
                @blur="onDraftBlur"
              />
              <span class="side-nav__edit-len" :class="{ 'side-nav__edit-len--over': folders.draftOver }">{{ draftLen }}/{{ maxName }}</span>
            </label>
            <span v-if="folders.draftOver" class="side-nav__edit-over" role="alert">最多 {{ maxName }} 个字</span>
          </div>
        </template>
        <span v-if="!sec.rows.length && sec.hint" class="side-nav__hint">{{ sec.hint }}</span>
      </div>
    </section>
  </nav>
</template>

<script lang="ts" src="./SideNav.ts"></script>
<style lang="scss" scoped src="./SideNav.scss"></style>
