<template>
  <div class="app-shell">
    <div class="app-shell__body">
      <SideNav />
      <GalleryView />
    </div>
    <StatusFooter />
    <FolderPickDialog />
    <AppToast />
  </div>
</template>

<script lang="ts" src="./AppShell.ts"></script>
<style lang="scss" scoped src="./AppShell.scss"></style>
