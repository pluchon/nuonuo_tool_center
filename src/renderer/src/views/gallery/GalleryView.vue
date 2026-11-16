<template>
  <!-- 第一次打开：还没有任何源目录 -->
  <main v-if="library.firstRun" class="gallery gallery--welcome">
    <section class="gallery__welcome" aria-label="开始使用">
      <NonoArt pose="welcome" size="large" />
      <button class="gallery__pick" type="button" :disabled="library.importing" @click="onPick">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>选择图片文件夹
      </button>
    </section>
  </main>

  <!-- 读图库概况失败 -->
  <main v-else-if="library.error" class="gallery gallery--state">
    <NonoArt pose="error" />
    <span class="gallery__text">图库读不出来</span>
    <button class="gallery__retry" type="button" :disabled="library.loading" @click="library.load()">重试</button>
  </main>

  <!-- 有源目录但还没有图片（扫描在下一阶段接入） -->
  <main v-else-if="library.overview" class="gallery gallery--state">
    <NonoArt pose="empty" />
    <span class="gallery__text">这里还没有图片</span>
  </main>

  <!-- 加载中：先留空，避免闪一下空状态 -->
  <main v-else class="gallery" aria-busy="true" />
</template>

<script lang="ts" src="./GalleryView.ts"></script>
<style lang="scss" scoped src="./GalleryView.scss"></style>
