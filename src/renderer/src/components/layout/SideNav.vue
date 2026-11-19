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
          :title="sec.add.label"
          :disabled="sec.add.disabled"
          @click="sec.add.run"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <div class="side-nav__rows">
        <div v-for="row in sec.rows" :key="row.key" class="side-nav__row">
          <button
            class="side-nav__item"
            :class="{ 'side-nav__item--on': row.active, 'side-nav__item--tree': row.tree }"
            type="button"
            :disabled="row.disabled"
            :aria-current="row.active ? 'page' : undefined"
            @click="row.go"
          >
            <span v-if="row.tree" class="side-nav__caret" :style="{ visibility: row.hasChildren ? 'visible' : 'hidden' }" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            </span>
            <svg
              class="side-nav__icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              :stroke="row.active ? 'var(--a-ink)' : row.ink"
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
        <span v-if="!sec.rows.length && sec.hint" class="side-nav__hint">{{ sec.hint }}</span>
      </div>
    </section>
  </nav>
</template>

<script lang="ts" src="./SideNav.ts"></script>
<style lang="scss" scoped src="./SideNav.scss"></style>
