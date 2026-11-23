<template>
  <div class="image-references nn-thin" aria-label="引用图片">
    <span v-for="r in items" :key="r.imageId" class="image-references__item" :data-position="r.position">
      <button type="button" class="image-references__open" :aria-label="'查看大图 ' + r.name"
        @dblclick="openImage(r.imageId)" @click="onActivate($event, r.imageId)">
        <svg class="image-references__fallback" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="4" /><path d="m4 17 5-6 4 4 3-3 5 6" />
        </svg>
        <img v-if="previews.has(r.imageId)" :key="previews.get(r.imageId)!.hash" :alt="r.name"
          :src="thumbUrl(previews.get(r.imageId)!.hash)" :class="{ masked: previews.get(r.imageId)!.isR18 }"
          loading="lazy" draggable="false" @error="hideMissing" />
        <span v-if="previews.get(r.imageId)?.isR18" class="image-references__lock" aria-label="R-18">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path :d="ICON.lock" /></svg>
        </span>
      </button>
      <button v-if="removable" class="image-references__remove" type="button" :aria-label="'移除引用 ' + r.name" @click="$emit('remove', r.imageId)">×</button>
    </span>
  </div>
</template>
<script setup lang="ts">
import type { AiImageReference, AiReferencePreview } from '@shared/api'
import { fetchImageDetail, thumbUrl } from '@/api/gallery'
import { useViewerStore } from '@/stores/viewer'
import { useToastStore } from '@/stores/toast'
import { onBeforeUnmount } from 'vue'
import { ICON } from '@/theme/icons'
defineProps<{ items: AiImageReference[]; previews: Map<number, AiReferencePreview>; removable?: boolean }>()
defineEmits<{ remove: [imageId: number] }>()
const viewer = useViewerStore()
const toast = useToastStore()
let request = 0
onBeforeUnmount(() => { request++ })
async function openImage(id: number) {
  const version = ++request
  try {
    const item = await fetchImageDetail(id)
    if (version === request) viewer.showList([item], id)
  } catch (error) {
    if (version === request) toast.show(error instanceof Error ? error.message : String(error), 'error')
  }
}
function onActivate(event: MouseEvent, id: number) {
  if (event.detail === 0) void openImage(id)
}
function hideMissing(event: Event) { (event.currentTarget as HTMLImageElement).hidden = true }
</script>
<style scoped>
.image-references { display:flex; flex-wrap:wrap; gap:6px; max-height:120px; max-width:100%; overflow:auto; }
.image-references__item { width:54px; height:54px; position:relative; display:grid; place-items:center; overflow:hidden;
  border-radius:10px; background:var(--a-bg); color:var(--a-mid); border:1px solid var(--a-line2); }
img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.masked { filter:blur(8px); transform:scale(1.25); }
.image-references__open { position:absolute; inset:0; display:grid; place-items:center; width:100%; height:100%; padding:0; border:0; color:inherit; background:transparent; cursor:zoom-in; }
.image-references__lock, .image-references__remove { position:absolute; right:2px; display:grid; place-items:center; border-radius:50%; color:white; }
.image-references__lock { bottom:2px; width:15px; height:15px; background:#ae3151; }
.image-references__remove { top:2px; width:18px; height:18px; padding:0; border:0; background:rgb(29 23 42 / .76); font:15px/1 sans-serif; cursor:pointer; }
button:focus-visible { outline:2px solid white; outline-offset:-2px; }
</style>
