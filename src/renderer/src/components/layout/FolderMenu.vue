<template>
  <div v-if="folders.menu" class="folder-menu" @click="folders.closeMenu()" @contextmenu.prevent="folders.closeMenu()">
    <div class="folder-menu__box" role="menu" :style="{ left: `${folders.menu.x}px`, top: `${folders.menu.y}px` }" @click.stop @contextmenu.prevent>
      <span class="folder-menu__arrow" aria-hidden="true" />
      <button v-for="m in groups.list" :key="m.label" class="folder-menu__item" role="menuitem" type="button" @click="m.run">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="folder-menu__icon" aria-hidden="true"><path :d="m.icon" /></svg>{{ m.label }}
      </button>
      <template v-if="groups.danger.length">
        <div class="folder-menu__sep" aria-hidden="true" />
        <button v-for="m in groups.danger" :key="m.label" class="folder-menu__item folder-menu__item--danger" role="menuitem" type="button" @click="m.run">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="folder-menu__icon" aria-hidden="true"><path :d="m.icon" /></svg>{{ m.label }}
        </button>
      </template>
    </div>
  </div>
</template>

<script lang="ts" src="./FolderMenu.ts"></script>
<style lang="scss" scoped src="./FolderMenu.scss"></style>
