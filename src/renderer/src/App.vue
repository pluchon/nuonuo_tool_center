<template>
  <div class="app-root">
    <TitleBar />
    <DbErrorView v-if="boot.fatal" />
    <AppShell v-else-if="boot.ready && settings.loaded" />
  </div>
</template>

<script lang="ts" src="./App.ts"></script>
<style lang="scss" scoped src="./App.scss"></style>
