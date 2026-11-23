<template>
  <Transition name="nn-dlg">
    <div v-if="viewer.open && (item || viewer.attachment)" class="viewer" @mousedown="onMaskDown" @click="onMaskClick">
      <div class="viewer__frame nn-dlg-panel" role="dialog" aria-modal="true" aria-label="查看大图">
        <div class="viewer__card">
          <div class="viewer__head">
            <span class="viewer__dot" aria-hidden="true"></span>
            <h2 class="viewer__title">{{ title }}</h2>
            <span v-if="position" class="viewer__pos">{{ position }}</span>
            <button ref="closeRef" class="viewer__close" type="button" aria-label="关闭" @click="viewer.close()">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
            </button>
          </div>

          <div ref="stageRef" class="viewer__stage">
            <template v-if="multi">
              <button class="viewer__nav viewer__nav--prev" type="button" aria-label="上一张" @click="viewer.step(-1)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
              </button>
              <button class="viewer__nav viewer__nav--next" type="button" aria-label="下一张" @click="viewer.step(1)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            </template>

            <div v-if="source.kind !== 'none'" class="viewer__pan" :style="{ cursor }" @mousedown="onMouseDown" @dblclick="onDblClick" @wheel="onWheel">
              <img v-if="placeholder" class="viewer__ph" :src="placeholder" :style="picStyle" alt="" draggable="false" />
              <img
                :key="source.src"
                class="viewer__pic"
                :class="{ 'viewer__pic--wait': !picReady }"
                :src="source.src"
                :style="picStyle"
                alt=""
                draggable="false"
                decoding="async"
                @load="onLoad"
                @error="onError"
              />
            </div>
            <div v-else class="viewer__empty">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
              <span class="viewer__empty-text">无法预览</span>
              <button v-if="item" class="viewer__empty-btn" type="button" @click="onOpenDefault">用默认程序打开</button>
            </div>

            <span v-if="note" class="viewer__note">{{ note }}</span>
          </div>

          <div class="viewer__bar">
            <div class="viewer__group" role="toolbar" aria-label="缩放">
              <button class="viewer__round" type="button" aria-label="缩小" @click="zoomOut">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6" /></svg>
              </button>
              <span class="viewer__zoom">{{ zoom }}%</span>
              <button class="viewer__round" type="button" aria-label="放大" @click="zoomIn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6M11 8v6" /></svg>
              </button>
              <span class="viewer__sep" aria-hidden="true"></span>
              <button class="viewer__pill" type="button" @click="fitWindow">适应窗口</button>
              <button class="viewer__pill" type="button" @click="actual">原始大小</button>
            </div>
            <div class="viewer__group" role="toolbar" aria-label="旋转与翻转">
              <button class="viewer__round viewer__round--mint" type="button" aria-label="向左旋转" @click="rotL">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v6h6" /><path d="M4.5 10A8 8 0 1 1 6 16.5" /></svg>
              </button>
              <button class="viewer__round viewer__round--mint" type="button" aria-label="向右旋转" @click="rotR">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 4v6h-6" /><path d="M19.5 10A8 8 0 1 0 18 16.5" /></svg>
              </button>
              <button
                class="viewer__round viewer__round--pink"
                :class="{ 'viewer__round--on': flipped }"
                type="button"
                aria-label="水平翻转"
                :aria-pressed="flipped"
                @click="flip"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18" /><path d="M8 7L3 12l5 5z" /><path d="M16 7l5 5-5 5z" /></svg>
              </button>
              <span class="viewer__sep" aria-hidden="true"></span>
              <button class="viewer__pill" type="button" @click="resetView">还原</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script lang="ts" src="./ImageViewer.ts"></script>
<style lang="scss" scoped src="./ImageViewer.scss"></style>
