<template>
  <div class="app-shell">
    <div class="app-shell__art" :style="artStyle" aria-hidden="true" />
    <div class="app-shell__tint" aria-hidden="true" />
    <div class="app-shell__rain" aria-hidden="true" />

    <TitleBar />
    <div class="app-shell__body">
      <SideBar />
      <main class="app-shell__main">
        <router-view />
      </main>
    </div>
    <StatusBar />
  </div>
</template>

<script lang="ts" src="./AppShell.ts"></script>
<style lang="scss" scoped src="./AppShell.scss"></style>
