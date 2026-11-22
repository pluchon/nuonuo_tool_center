<template>
  <div class="image-grid-wrap">
    <div ref="gridRef" class="image-grid nn-noscroll" @wheel="onWheel">
      <section v-for="g in groups" :key="g.key" class="image-grid__group" :data-month="g.key">
        <div v-if="g.timeline" class="image-grid__head">
          <span class="image-grid__bar" aria-hidden="true" />
          <h3 class="image-grid__title">{{ g.label }}</h3>
          <svg class="image-grid__star" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l2.3 8.2 8.2 2.3-8.2 2.3-2.3 8.2-2.3-8.2L1.5 12l8.2-2.3z" /></svg>
          <span class="image-grid__dash" aria-hidden="true" />
          <button
            class="image-grid__all"
            :class="{ 'image-grid__all--on': g.allOn }"
            type="button"
            role="checkbox"
            :aria-checked="g.allOn"
            :aria-label="g.allOn ? '取消选择' : '选择本月'"
            @click="gallery.toggleGroup(g.ids)"
          >
            {{ g.allOn ? '✓' : '' }}
          </button>
          <span class="image-grid__count">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>{{ g.ids.length }} 张
          </span>
        </div>
        <!-- “AI 建议”视图：按建议放进的类目录分组，组头可以一起采用 -->
        <div v-else-if="g.aiDir" class="image-grid__head image-grid__head--dir">
          <span class="image-grid__bar" aria-hidden="true" />
          <svg v-if="g.aiDir.name" class="image-grid__arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          <h3 class="image-grid__title">{{ g.label }}</h3>
          <span v-if="g.aiDir.isNew" class="image-grid__new">新建</span>
          <span class="image-grid__dash" aria-hidden="true" />
          <span class="image-grid__count">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>{{ g.ids.length }} 张
          </span>
          <button class="image-grid__accept" type="button" :disabled="suggest.busy" @click="suggest.decide(g.ids, true)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>这一组全部采用
          </button>
        </div>

        <div v-for="(row, ri) in g.rows" :key="ri" class="image-grid__row" :style="rowStyle">
          <button
            v-for="t in row.tiles"
            :key="t.id"
            class="tile"
            :class="{ 'tile--on': gallery.isSelected(t.id), 'tile--multi': gallery.multi }"
            type="button"
            :data-id="t.id"
            :aria-label="item(t.id).name"
            :aria-pressed="gallery.isSelected(t.id)"
            :style="{ width: `${t.width}px` }"
            :draggable="!item(t.id).missing && !item(t.id).offline"
            @mousedown="onTileDown"
            @click="onTileClick($event, t.id)"
            @dblclick="viewer.show(t.id)"
            @dragstart="onDragStart($event, t.id)"
            @dragend="gallery.endDrag()"
          >
            <span
              class="tile__chk"
              role="checkbox"
              :aria-checked="gallery.multi && gallery.isSelected(t.id)"
              aria-label="选择这张图"
              @click.stop="gallery.toggle(t.id)"
            >{{ gallery.multi && gallery.isSelected(t.id) ? '✓' : '' }}</span>
            <div
              class="tile__img"
              :class="{ 'tile__img--offline': item(t.id).offline }"
              :style="{ height: `${gallery.rowHeight}px` }"
            >
              <img
                v-if="item(t.id).thumb === 'READY'"
                class="tile__pic"
                :class="{ 'tile__pic--masked': masked(t.id) }"
                :src="thumbUrl(item(t.id).hash)"
                alt=""
                loading="lazy"
                decoding="async"
                draggable="false"
              />
              <span v-if="item(t.id).thumb === 'PENDING' && !item(t.id).missing" class="tile__shim" role="img" aria-label="缩略图生成中" />
              <span v-if="item(t.id).missing" class="tile__bad tile__bad--missing">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9.5 12.5l5 5M14.5 12.5l-5 5" /></svg>文件不见了
              </span>
              <span v-else-if="item(t.id).thumb === 'FAILED'" class="tile__bad">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18v14H3zM3 15l5-5 4 4M14 12l2-2 5 5M8 3l2 4M16 21l-2-4" /></svg>无法预览
              </span>
              <span v-if="masked(t.id)" class="tile__r18">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg><span class="tile__r18-text">R-18</span>
              </span>
              <span class="tile__badge tile__badge--fmt">{{ item(t.id).format }}</span>
              <span v-if="t.crop" class="tile__badge tile__badge--crop">{{ t.crop }}</span>
            </div>
            <div class="tile__foot">
              <span class="tile__name">{{ item(t.id).name }}</span>
              <span v-if="!item(t.id).tagged" class="tile__dot" aria-label="还没打标签" />
            </div>
          </button>
        </div>
      </section>
    </div>
    <GridScrollbar :target="gridRef" :timeline="groups[0]?.timeline ?? false" :revision="groups" />
  </div>
</template>

<script lang="ts" src="./ImageGrid.ts"></script>
<style lang="scss" scoped src="./ImageGrid.scss"></style>
