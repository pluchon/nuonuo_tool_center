<template>
  <header class="title-bar">
    <div class="title-bar__logo" :style="logoStyle" aria-hidden="true" />
    <span class="title-bar__name">诺诺的图书馆</span>
    <span class="title-bar__crumb">· {{ pageTitle }}</span>
    <div class="title-bar__actions">
      <el-tooltip :content="theme.mode === 'dark' ? '切到雨天午后' : '切到夜雨灯笼'" placement="bottom">
        <button class="title-bar__btn" type="button" aria-label="切换主题" @click="onToggleTheme">
          <el-icon><Sunny v-if="theme.mode === 'dark'" /><Moon v-else /></el-icon>
        </button>
      </el-tooltip>
    </div>
  </header>
</template>

<script lang="ts" src="./TitleBar.ts"></script>
<style lang="scss" scoped src="./TitleBar.scss"></style>
