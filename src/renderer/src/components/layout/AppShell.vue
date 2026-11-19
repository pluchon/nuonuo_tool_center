<template>
  <div class="app-shell">
    <div class="app-shell__body">
      <SideNav />
      <TagsView v-if="viewStore.page === 'tags'" />
      <GalleryView v-else />
    </div>
    <StatusFooter />
    <FolderPickDialog />
    <TransferDialog />
    <AppToast />
  </div>
</template>

<script lang="ts" src="./AppShell.ts"></script>
<style lang="scss" scoped src="./AppShell.scss"></style>
