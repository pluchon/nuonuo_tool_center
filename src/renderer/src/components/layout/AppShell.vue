<template>
  <div class="app-shell" @dragover="onWindowDragOver" @drop="onWindowDrop">
    <div class="app-shell__body">
      <SideNav />
      <TagsView v-if="viewStore.page === 'tags'" />
      <GalleryView v-else />
    </div>
    <StatusFooter />
    <FolderPickDialog />
    <TransferDialog />
    <FolderMenu />
    <ConfirmDialog
      :open="!!folders.danger"
      :title="dangerTitle"
      :ok-label="folders.danger?.ref.kind === 'source' ? '移除' : '删除'"
      :no-label="folders.danger?.ref.kind === 'source' ? '先不移除' : '先不删'"
      :icon="folders.danger?.ref.kind === 'source' ? 'M5 12h14' : undefined"
      :busy="folders.busy"
      @ok="folders.confirmDanger()"
      @cancel="folders.cancelDanger()"
    />
    <ConfirmDialog
      :open="!!gallery.dropAsk"
      :title="dropTitle"
      tone="normal"
      :ok-label="gallery.dropAsk?.move ? '移动' : '复制'"
      no-label="先不了"
      :icon="gallery.dropAsk?.move ? 'M5 12h14M13 6l6 6-6 6' : 'M9 9h10v10H9zM5 15V5h10'"
      :busy="gallery.deleteBusy"
      @ok="gallery.confirmDrop()"
      @cancel="gallery.cancelDrop()"
    />
    <ImageViewer />
    <SettingsDialog />
    <AppToast />
  </div>
</template>

<script lang="ts" src="./AppShell.ts"></script>
<style lang="scss" scoped src="./AppShell.scss"></style>
