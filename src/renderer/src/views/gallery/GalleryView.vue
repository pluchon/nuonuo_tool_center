<template>
  <!-- 第一次打开：还没有任何源目录 -->
  <main v-if="library.firstRun" class="gallery gallery--welcome">
    <section class="gallery__welcome" aria-label="开始使用">
      <NonoArt pose="welcome" size="large" />
      <button class="gallery__pick" type="button" :disabled="picker.busy" @click="picker.openImport()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>选择图片文件夹
      </button>
    </section>
  </main>

  <!-- 读图库概况失败（还没读到过任何数据） -->
  <main v-else-if="library.error && !library.overview" class="gallery gallery--state">
    <NonoArt pose="error" />
    <span class="gallery__text">图库读不出来</span>
    <button class="gallery__retry" type="button" :disabled="library.loading" @click="library.load()">重试</button>
  </main>

  <!-- 主区：筛选栏、状态横幅、图片网格；右侧详情面板 -->
  <div v-else-if="library.overview" class="gallery gallery--main">
    <main class="gallery__column">
      <FilterBar />
      <StatusBanner />
      <div v-if="gallery.error && gallery.items.length === 0" class="gallery__empty">
        <NonoArt pose="error" />
        <span class="gallery__text">图片读不出来</span>
        <button class="gallery__retry" type="button" :disabled="gallery.loading" @click="gallery.load()">重试</button>
      </div>
      <div v-else-if="gallery.loaded && gallery.items.length === 0" class="gallery__empty nn-appear">
        <NonoArt pose="empty" />
        <span class="gallery__text">{{ emptyText }}</span>
      </div>
      <!-- 换视图或筛选条件时网格整体淡入（扫描中的刷新不换 key，不闪） -->
      <ImageGrid v-else-if="gallery.items.length > 0" :key="gallery.queryKey" class="nn-appear" />
    </main>
    <!-- 详情面板：列表空了往右收起、网格跟着变宽；有图了再展开 -->
    <Transition name="side">
      <div v-if="gallery.items.length > 0" class="gallery__side">
        <DetailPanel />
      </div>
    </Transition>
    <ConfirmDialog
      :open="!!gallery.deleteAsk"
      :title="deleteTitle"
      :busy="gallery.deleteBusy"
      @ok="gallery.confirmDelete()"
      @cancel="gallery.cancelDelete()"
    />
  </div>

  <!-- 加载中：先留空，避免闪一下空状态 -->
  <main v-else class="gallery" aria-busy="true" />
</template>

<script lang="ts" src="./GalleryView.ts"></script>
<style lang="scss" scoped src="./GalleryView.scss"></style>
