<template>
  <header class="title-bar">
    <img class="title-bar__brand" :src="brandAvatar" alt="" aria-hidden="true" draggable="false" />
    <span class="title-bar__name">诺诺的图床</span>
    <!-- 设置弹窗在设置阶段接入，现在先占位 -->
    <button class="title-bar__gear" type="button" aria-label="设置" title="设置" disabled>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>

    <div class="title-bar__controls">
      <button class="title-bar__win title-bar__win--min" type="button" aria-label="最小化" @click="onMinimize">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7.5 10.75q4.5 5 9 0" /></svg>
      </button>
      <button class="title-bar__win title-bar__win--max" type="button" aria-label="最大化" @click="onToggleMaximize">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 10V16.5a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V10L16 5.5l-2.5 3h-3L8 5.5z" /></svg>
      </button>
      <button class="title-bar__win title-bar__win--close" type="button" aria-label="关闭" @click="onClose">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
      </button>
    </div>
  </header>
</template>

<script lang="ts" src="./TitleBar.ts"></script>
<style lang="scss" scoped src="./TitleBar.scss"></style>
