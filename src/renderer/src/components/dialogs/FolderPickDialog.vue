<template>
  <div v-if="picker.open" class="folder-pick" @click="onClose">
    <div class="folder-pick__frame" role="dialog" aria-modal="true" :aria-label="title" @click.stop>
      <div class="folder-pick__card">
        <div class="folder-pick__head">
          <h2 class="folder-pick__title">{{ title }}</h2>
          <button class="folder-pick__close" type="button" aria-label="关闭" @click="onClose">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
          </button>
        </div>

        <div class="folder-pick__group">
          <div class="folder-pick__group-title"><span class="folder-pick__dot" aria-hidden="true" />此电脑</div>
          <div class="folder-pick__list">
            <el-tree
              ref="treeRef"
              class="folder-pick__tree"
              node-key="path"
              lazy
              :load="loadNode"
              :props="treeProps"
              :indent="18"
              :icon="ChevronIcon"
              :expand-on-click-node="false"
              @node-click="onNodeClick"
            >
              <template #default="{ data }">
                <span
                  class="folder-pick__row"
                  :class="{
                    'folder-pick__row--on': picked === data.path,
                    'folder-pick__row--locked': data.lock !== null,
                    'folder-pick__row--drive': data.isDrive
                  }"
                  role="radio"
                  :aria-checked="picked === data.path ? 'true' : 'false'"
                  :aria-disabled="data.isDrive || data.lock !== null ? 'true' : undefined"
                >
                  <span class="folder-pick__mark" aria-hidden="true">{{ picked === data.path ? '✓' : '' }}</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-b-3F8F7B)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                  <span class="folder-pick__label">{{ data.label }}</span>
                  <span class="folder-pick__note">{{ noteOf(data) }}</span>
                </span>
              </template>
            </el-tree>
          </div>
        </div>

        <button class="folder-pick__confirm" :class="{ 'folder-pick__confirm--ready': ready }" type="button" :disabled="!ready || busy" @click="onConfirm">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" src="./FolderPickDialog.ts"></script>
<style lang="scss" scoped src="./FolderPickDialog.scss"></style>
