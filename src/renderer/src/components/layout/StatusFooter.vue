<template>
  <footer class="status-footer">
    <span class="status-footer__item">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
      {{ countText }}
    </span>
    <span class="status-footer__sep" aria-hidden="true" />
    <span class="status-footer__item">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-i-3F8F7B)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" /></svg>
      {{ scanText }}
    </span>
    <!-- 扫描在导入扫描阶段接入，现在先不可点 -->
    <button class="status-footer__scan" type="button" title="重新扫描所有源目录" disabled>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>重新扫描
    </button>
  </footer>
</template>

<script lang="ts" src="./StatusFooter.ts"></script>
<style lang="scss" scoped src="./StatusFooter.scss"></style>
