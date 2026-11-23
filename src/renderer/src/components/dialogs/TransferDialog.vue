<template>
  <Transition name="nn-dlg">
    <div v-if="transfer.mode" class="transfer-dlg" @click="transfer.close()">
      <div class="transfer-dlg__frame nn-dlg-panel" role="dialog" aria-modal="true" :aria-label="title" @click.stop>
        <div class="transfer-dlg__card">
          <div class="transfer-dlg__head">
            <h2 class="transfer-dlg__title">{{ title }}</h2>
            <button class="transfer-dlg__close" type="button" aria-label="关闭" @click="transfer.close()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
            </button>
          </div>

          <span v-if="!transfer.roots" class="transfer-dlg__empty" role="status">正在读取目录…</span>
          <div v-for="g in groups" :key="g.key" class="transfer-dlg__group">
            <div class="transfer-dlg__group-title"><span class="transfer-dlg__dot" :style="{ background: g.dot }" aria-hidden="true" />{{ g.title }}</div>
            <div class="transfer-dlg__list">
              <span v-if="g.roots.length === 0" class="transfer-dlg__empty">{{ g.key === 'source' ? '还没有源目录' : '还没有类目录' }}</span>
              <el-tree
                v-else
                class="transfer-dlg__tree"
                node-key="path"
                lazy
                :load="loaderOf(g)"
                :props="treeProps"
                :indent="18"
                :icon="ChevronIcon"
                :default-expanded-keys="expandedKeys"
                :expand-on-click-node="false"
                @node-click="onNodeClick"
              >
                <template #default="{ data }">
                  <span
                    class="transfer-dlg__row"
                    :class="{
                      'transfer-dlg__row--on': transfer.picked.includes(data.path),
                      'transfer-dlg__row--locked': lockedOf(data)
                    }"
                    :role="isCopy ? 'checkbox' : 'radio'"
                    :aria-checked="transfer.picked.includes(data.path) ? 'true' : 'false'"
                    :aria-disabled="lockedOf(data) ? 'true' : undefined"
                  >
                    <span class="transfer-dlg__mark" :class="{ 'transfer-dlg__mark--box': isCopy }" aria-hidden="true">{{ transfer.picked.includes(data.path) ? '✓' : '' }}</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" :stroke="g.dot" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                    <span class="transfer-dlg__label">{{ data.label }}</span>
                    <span class="transfer-dlg__note">{{ noteOf(data) }}</span>
                  </span>
                </template>
              </el-tree>
            </div>
          </div>

          <!-- 其他位置：Windows 自己的选文件夹对话框，可以放到图库外（复制等于导出一份，移动等于移出图库） -->
          <div class="transfer-dlg__group">
            <div class="transfer-dlg__group-title"><span class="transfer-dlg__dot transfer-dlg__dot--other" aria-hidden="true" />其他位置</div>
            <div class="transfer-dlg__others">
              <button
                v-for="p in transfer.others"
                :key="p"
                class="transfer-dlg__row transfer-dlg__row--other"
                :class="{ 'transfer-dlg__row--on': transfer.picked.includes(p) }"
                type="button"
                :role="isCopy ? 'checkbox' : 'radio'"
                :aria-checked="transfer.picked.includes(p) ? 'true' : 'false'"
                :title="p"
                @click="transfer.toggle(p)"
              >
                <span class="transfer-dlg__mark" :class="{ 'transfer-dlg__mark--box': isCopy }" aria-hidden="true">{{ transfer.picked.includes(p) ? '✓' : '' }}</span>
                <span class="transfer-dlg__label transfer-dlg__label--path">{{ p }}</span>
                <span class="transfer-dlg__note">{{ transfer.inLibrary(p) ? '' : '图库外' }}</span>
              </button>
              <button class="transfer-dlg__pick" type="button" :disabled="!transfer.roots || transfer.busy" @click="transfer.pickOther()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /></svg>
                选择文件夹…
              </button>
            </div>
          </div>

          <button
            class="transfer-dlg__confirm"
            :class="{ 'transfer-dlg__confirm--ready': ready }"
            type="button"
            :disabled="!ready || transfer.busy"
            @click="transfer.confirm()"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script lang="ts" src="./TransferDialog.ts"></script>
<style lang="scss" scoped src="./TransferDialog.scss"></style>
