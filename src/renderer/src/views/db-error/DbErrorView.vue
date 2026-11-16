<template>
  <div class="db-error">
    <section class="db-error__box" role="alertdialog" :aria-label="title">
      <NonoArt pose="error" />
      <h1 class="db-error__title">{{ title }}</h1>
      <button class="db-error__retry" type="button" :disabled="boot.retrying" @click="onRetry">重试</button>
    </section>
  </div>
</template>

<script lang="ts" src="./DbErrorView.ts"></script>
<style lang="scss" scoped src="./DbErrorView.scss"></style>
