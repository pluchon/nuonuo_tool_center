<template>
  <Transition name="nn-dlg">
    <div v-if="org.reorganizeDialog" class="reorg-dlg" @click="org.closeReorganize()">
      <section
        class="reorg-dlg__card nn-dlg-panel"
        role="dialog"
        aria-modal="true"
        aria-label="重新整理"
        @click.stop
      >
        <header class="reorg-dlg__hero">
          <svg class="reorg-dlg__deco reorg-dlg__deco--a" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" /></svg>
          <svg class="reorg-dlg__deco reorg-dlg__deco--b" width="9" height="9" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" /></svg>
          <svg class="reorg-dlg__deco reorg-dlg__deco--c" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" /></svg>
          <span class="reorg-dlg__badge">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
          </span>
          <div class="reorg-dlg__heading">
            <h2 class="reorg-dlg__title">重新整理</h2>
          </div>
          <button ref="closeRef" class="reorg-dlg__x" type="button" aria-label="暂不操作" @click="org.closeReorganize()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
          </button>
        </header>

        <div class="reorg-dlg__stats" role="status" :aria-busy="!est" :aria-label="est ? '重新整理估算' : '正在估算'">
          <div v-for="s in stats" :key="s.key" class="reorg-dlg__stat" :class="`reorg-dlg__stat--${s.key}`">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="s.icon" /></svg>
            <span>{{ s.label }}</span>
            <b v-if="est">{{ s.value }}</b>
            <span v-else class="reorg-dlg__spinner" aria-hidden="true"></span>
          </div>
        </div>

        <ul class="reorg-dlg__lines">
          <li v-for="l in lines" :key="l.text">
            <span class="reorg-dlg__dot"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="l.icon" /></svg></span>{{ l.text }}
          </li>
        </ul>

        <p v-if="diagnosticHint" class="reorg-dlg__hint" role="status">{{ diagnosticHint }}</p>

        <div class="reorg-dlg__btns">
          <button
            class="reorg-dlg__reset"
            type="button"
            :disabled="org.reorganizeBusy || !est || est.organizedCount === 0"
            @click="org.resetToSource()"
          >
            已整理图片归回源目录
          </button>
          <button
            class="reorg-dlg__go"
            type="button"
            :disabled="org.reorganizeBusy || !est || est.organizedCount === 0 || (est.toLook === 0 && est.ratingLeft === 0)"
            @click="org.relookOrganized()"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" fill="currentColor" /></svg>已整理图片重新AI整理
          </button>
        </div>
      </section>
    </div>
  </Transition>
</template>

<script lang="ts" src="./ReorganizeDialog.ts"></script>
<style lang="scss" scoped src="./ReorganizeDialog.scss"></style>
