<template>
  <aside class="detail-panel nn-noscroll" aria-label="图片详情">
    <!-- 多选：批量面板 -->
    <BatchPanel v-if="gallery.multi" />

    <template v-else-if="detail">
      <div v-if="notice" class="detail-panel__notice" :class="`detail-panel__notice--${notice.kind}`" role="alert">
        <div class="detail-panel__notice-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8v5M12 16.5h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>{{ notice.title }}
        </div>
        <button v-if="notice.kind === 'broken'" class="detail-panel__notice-btn" type="button" @click="onOpenDefault">用默认程序打开</button>
      </div>

      <div class="detail-panel__preview">
        <img v-if="detail.thumb === 'READY'" :key="detail.hash" class="detail-panel__pic nn-appear" :class="{ 'detail-panel__pic--off': location?.offline }" :src="thumbUrl(detail.hash)" alt="" draggable="false" />
        <svg v-else width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
        <button class="detail-panel__zoom" type="button" aria-label="查看大图" @click="viewer.show()"></button>
        <button
          class="detail-panel__del"
          type="button"
          aria-label="删除"
          :disabled="!!location?.offline"
          @click="gallery.askDelete()"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </button>
      </div>

      <div class="detail-panel__block">
        <div class="detail-panel__row-head">
          <label class="detail-panel__label" for="nameInput">图片好名字</label>
          <span class="detail-panel__label" :class="{ 'detail-panel__over': nameOver }">{{ nameOver ? `最多 ${nameMax} 个字 · ` : '' }}{{ nameLen }}/{{ nameMax }}</span>
        </div>
        <input
          id="nameInput"
          class="detail-panel__name"
          :class="{ 'detail-panel__name--over': nameOver }"
          :value="nameDraft"
          :placeholder="fileName"
          @input="onNameInput"
          @keydown.enter="onNameEnter"
          @keydown.esc.stop="onNameCancel"
          @blur="saveName"
        />
        <div class="detail-panel__file">
          <span class="detail-panel__file-name">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
            <span class="detail-panel__ellipsis" :title="fileName">{{ fileName }}</span>
          </span>
          <span v-if="dims" class="detail-panel__chip detail-panel__chip--green">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" /></svg>{{ dims }}
          </span>
          <span class="detail-panel__chip detail-panel__chip--orange">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></svg>{{ size }}
          </span>
        </div>

        <div v-if="exif" class="detail-panel__exif">
          <div class="detail-panel__row-head">
            <span class="detail-panel__label">拍摄信息</span>
            <span class="detail-panel__taken">{{ exif.taken }}</span>
          </div>
          <div class="detail-panel__exif-box">
            <div v-if="exif.camera" class="detail-panel__exif-line">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
              <span class="detail-panel__exif-key">机身</span>
              <span class="detail-panel__exif-val">{{ exif.camera }}</span>
            </div>
            <div v-if="exif.lens" class="detail-panel__exif-line">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /></svg>
              <span class="detail-panel__exif-key">镜头</span>
              <span class="detail-panel__exif-val" :title="exif.lens">{{ exif.lens }}</span>
            </div>
            <div class="detail-panel__params">
              <div v-for="p in exif.params" :key="p.k" class="detail-panel__param">
                <span class="detail-panel__param-k">{{ p.k }}</span>
                <span class="detail-panel__param-v">{{ p.v }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <TagEditor :tags="detail.tags" :image-id="detail.imageId" />

      <div v-if="location" class="detail-panel__block">
        <span class="detail-panel__label">图片源路径</span>
        <div class="detail-panel__path" :title="location.path">
          <button class="detail-panel__open" type="button" aria-label="打开源目录" :disabled="location.offline" @click="onShowInFolder">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5" /><path d="M3 7v10a2 2 0 0 0 2 2h12.5l3-8H7.5L5 17" /></svg>
          </button>
          <span class="detail-panel__path-text">{{ location.path }}</span>
        </div>
      </div>

      <div class="detail-panel__r18" :class="{ 'detail-panel__r18--on': detail.isR18 }">
        <span class="detail-panel__r18-label">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="3" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          R-18
        </span>
        <button class="detail-panel__switch" type="button" role="switch" :aria-checked="detail.isR18" aria-label="标为 R-18" @click="gallery.setR18(!detail.isR18)">
          <span class="detail-panel__knob" />
        </button>
      </div>

      <div class="detail-panel__foot">
        <div class="detail-panel__acts">
          <button class="detail-panel__act" type="button" :disabled="!canTransfer" @click="transfer.open('copy')">复制到…</button>
          <button class="detail-panel__act detail-panel__act--main" type="button" :disabled="!canTransfer" @click="transfer.open('move')">移动到…</button>
        </div>
        <div v-if="importText" class="detail-panel__imported">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="导入时间"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 3" /></svg>
          <span>{{ importText }}</span>
        </div>
      </div>
    </template>

    <span v-else-if="gallery.detailError" class="detail-panel__error">{{ gallery.detailError }}</span>
  </aside>
</template>

<script lang="ts" src="./DetailPanel.ts"></script>
<style lang="scss" scoped src="./DetailPanel.scss"></style>
