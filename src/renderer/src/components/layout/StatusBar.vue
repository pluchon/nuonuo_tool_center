<template>
  <footer class="status-bar">
    <span class="status-bar__item">
      <el-icon class="status-bar__paw"><Collection /></el-icon>{{ store.roots.length }} 个目录
    </span>
    <span v-if="dbLabel" class="status-bar__item">{{ dbLabel }}</span>
    <span class="status-bar__spacer" />
    <template v-if="store.systemInfo">
      <span class="status-bar__chip" :class="chipClass(store.systemInfo.credentials.dashscope)">百炼</span>
      <span class="status-bar__chip" :class="chipClass(store.systemInfo.credentials.aliyunAccessKey)">OSS</span>
    </template>
  </footer>
</template>

<script lang="ts" src="./StatusBar.ts"></script>
<style lang="scss" scoped src="./StatusBar.scss"></style>
