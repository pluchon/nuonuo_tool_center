<template>
  <aside class="side-bar nn-glass">
    <div class="side-bar__group">图库</div>
    <router-link to="/" class="side-bar__item" active-class="side-bar__item--on">
      <el-icon><Picture /></el-icon>
      <span>全部图片</span>
    </router-link>

    <div class="side-bar__group">目录</div>
    <div class="side-bar__roots">
      <el-tooltip v-for="root in store.roots" :key="root.id" :content="root.path" placement="right">
        <div class="side-bar__item">
          <el-icon><FolderOpened /></el-icon>
          <span class="side-bar__label">{{ root.name }}</span>
        </div>
      </el-tooltip>
      <button class="side-bar__add" type="button" :disabled="store.importing" @click="onImport">
        <el-icon><Plus /></el-icon>
        <span>{{ store.importing ? '正在打开…' : '导入目录' }}</span>
      </button>
    </div>

    <NonoBubble class="side-bar__nono" :message="nonoMessage" />
  </aside>
</template>

<script lang="ts" src="./SideBar.ts"></script>
<style lang="scss" scoped src="./SideBar.scss"></style>
