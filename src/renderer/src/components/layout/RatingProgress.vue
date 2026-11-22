<template>
  <!-- 本地分级在跑时：一颗小胶囊（盾牌图标、字、细进度条、数字），不能点开，判完就收起 -->
  <Transition name="nn-pop">
    <div
      v-if="org.rating.running"
      class="rating-pill"
      role="progressbar"
      aria-label="本地分级进度"
      :aria-valuemin="0"
      :aria-valuemax="org.rating.total"
      :aria-valuenow="org.rating.done"
    >
      <svg class="rating-pill__icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
      <span class="rating-pill__text">本地分级中</span>
      <span class="rating-pill__bar"><span class="rating-pill__fill" :style="{ width: `${percent}%` }" /></span>
      <span class="rating-pill__num">{{ org.rating.done }}<i>/</i>{{ org.rating.total }}</span>
    </div>
  </Transition>
</template>

<script lang="ts" src="./RatingProgress.ts"></script>
<style lang="scss" scoped src="./RatingProgress.scss"></style>
