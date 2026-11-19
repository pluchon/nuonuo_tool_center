<template>
  <div v-if="banner" class="status-banner" :class="`status-banner--${banner.kind}`" role="status">
    <span class="status-banner__icon">
      <svg :class="{ 'status-banner__spin': banner.kind === 'scan' }" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="banner.icon" /></svg>
    </span>
    <div class="status-banner__body">
      <div class="status-banner__line">
        <span class="status-banner__title">{{ banner.title }}</span>
        <span v-if="banner.kind === 'scan'" class="status-banner__count">
          已扫描<span class="status-banner__done">{{ banner.done }}</span><span class="status-banner__slash">/</span><span class="status-banner__total">{{ banner.total }}</span>个文件
        </span>
      </div>
      <div v-if="banner.kind === 'scan'" class="status-banner__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="banner.pct">
        <div class="status-banner__fill" :style="{ width: `${banner.pct}%` }" />
      </div>
    </div>
    <button class="status-banner__btn" type="button" :disabled="busy" @click="banner.run">{{ banner.button }}</button>
  </div>
</template>

<script lang="ts" src="./StatusBanner.ts"></script>
<style lang="scss" scoped src="./StatusBanner.scss"></style>
