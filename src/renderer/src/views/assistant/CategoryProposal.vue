<template>
  <section class="category-proposal" aria-label="类目录提案" :aria-busy="busy">
    <template v-if="plan">
      <header>
        <strong>{{ title }}</strong>
        <div v-if="plan.filingPreview" class="category-proposal__previews" role="img" :aria-label="plan.filingPreview.total + ' 张待复制图片'">
          <span v-for="(hash, i) in plan.filingPreview.hashes" :key="i" class="category-proposal__thumb">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path :d="ICON.img" /></svg>
            <img v-if="hash" :key="hash" :src="thumbUrl(hash)" alt="" draggable="false" @error="hideMissing" />
          </span>
          <span v-if="plan.filingPreview.total > plan.filingPreview.hashes.length" class="category-proposal__more">+{{ plan.filingPreview.total - plan.filingPreview.hashes.length }}</span>
        </div>
        <svg v-else-if="plan.status === 'applied'" class="category-proposal__done" role="img" aria-label="已完成" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7" /></svg>
        <small v-else-if="plan.status === 'cancelled'">已取消</small>
      </header>
      <small v-if="!plan.entries.length">没有可用的目录名</small>
      <div v-else class="category-proposal__list nn-thin">
        <section v-for="group in groups" :key="group.parent">
          <h4 v-if="group.parent">{{ group.parent }}</h4>
          <ul>
            <li v-for="row in group.rows" :key="row.entry.path" :class="{ 'category-proposal__destination': row.entry.kind === 'copy' }">
              <template v-if="row.entry.kind === 'copy'">
                <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="ICON.folder" /></svg>
                <span class="category-proposal__path" :aria-label="row.entry.path">
                  <span v-for="(part, i) in row.parts" :key="i"><i v-if="i" aria-hidden="true">›</i>{{ part }}</span>
                </span>
              </template>
              <span v-else>{{ row.label }}</span>
              <small v-if="row.entry.kind !== 'copy' && row.entry.count">{{ row.entry.count }} 张</small>
            </li>
          </ul>
        </section>
      </div>
      <div v-if="plan.status === 'pending'" class="category-proposal__actions">
        <button type="button" :disabled="busy" @click="decide(true)">{{ plan.started ? '继续完成' : '确认' }}</button>
        <button v-if="!plan.started" type="button" :disabled="busy" @click="decide(false)">取消</button>
      </div>
    </template>
    <span v-if="error" role="alert">{{ error }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { CategoryProposalVO } from '@shared/api'
import { thumbUrl } from '@/api/gallery'
import { ICON } from '@/theme/icons'
import { useFoldersStore } from '@/stores/folders'

const props = defineProps<{ proposalId: number; messageId: number; previewRevision: number }>()
const folders = useFoldersStore()
const plan = ref<CategoryProposalVO | null>(null)
const title = computed(() => plan.value?.analysisCount ? '按标签规划类目录' :
  plan.value?.entries[0]?.kind === 'copy' ? '复制图片到类目录' :
  plan.value?.entries[0]?.kind === 'move' ? '迁移类目录' : '创建类目录')
const groups = computed(() => {
  type Entry = CategoryProposalVO['entries'][number]
  const grouped = new Map<string, { entry: Entry; label: string; parts: string[] }[]>()
  for (const entry of plan.value?.entries ?? []) {
    const parts = entry.path.split(/[\\/]/u)
    const leaf = parts.at(-1)!
    const parent = plan.value?.analysisCount ? parts.slice(0, -1).join(' / ') : ''
    const rows = grouped.get(parent) ?? []
    rows.push({ entry, parts, label: entry.from ? entry.from + ' → ' + entry.path : parent ? leaf : entry.path })
    grouped.set(parent, rows)
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([parent, rows]) => ({ parent, rows }))
})
const error = ref('')
const busy = ref(false)
function hideMissing(event: Event) {
  (event.currentTarget as HTMLImageElement).hidden = true
}
let revision = 0
async function load() {
  const version = ++revision
  const { proposalId, messageId } = props
  try {
    const result = await window.api.ai.categoryProposal(proposalId, messageId)
    if (version !== revision || props.proposalId !== proposalId || props.messageId !== messageId) return
    if (result.ok) { plan.value = result.data; error.value = '' }
    else { plan.value = null; error.value = result.message }
  } catch (err) {
    if (version === revision) error.value = err instanceof Error ? err.message : String(err)
  }
}
async function decide(apply: boolean) {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.api.ai.decideCategoryProposal(props.proposalId, props.messageId, apply)
    if (!result.ok) { await load(); error.value = result.message; return }
    revision++
    plan.value = result.data
    error.value = ''
    window.dispatchEvent(new CustomEvent('category-proposal-updated', { detail: props.proposalId }))
    if (apply) await folders.afterChange()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally { busy.value = false }
}
const refresh = (event: Event) => { if ((event as CustomEvent<number>).detail === props.proposalId) void load() }
watch(() => [props.proposalId, props.messageId], () => { void load() }, { immediate: true })
watch(() => props.previewRevision, () => {
  if (plan.value && !plan.value.filingPreview) return
  plan.value?.filingPreview?.hashes.fill(null)
  void load()
})
onMounted(() => window.addEventListener('category-proposal-updated', refresh))
onUnmounted(() => window.removeEventListener('category-proposal-updated', refresh))
</script>

<style scoped lang="scss">
.category-proposal {
  display: grid;
  gap: 8px;
  width: min(100%, 34rem);
  box-sizing: border-box;
  padding: 12px 14px;
  border: 1px solid var(--a-soft);
  border-radius: 12px;
  overflow-wrap: anywhere;
  background: var(--a06);
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; min-height: 28px; gap: 12px; }
  .category-proposal__previews { margin-inline-start: auto; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 3px; }
  .category-proposal__thumb, .category-proposal__more, .category-proposal__done {
    display: grid; place-items: center; flex: none; box-sizing: border-box; width: 28px; height: 28px;
    border: 1px solid var(--a-line); border-radius: 7px; color: var(--a-ink); background: var(--a-bg);
  }
  .category-proposal__thumb {
    position: relative; overflow: hidden;
    img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  }
  .category-proposal__more { width: auto; min-width: 28px; padding: 0 4px; border-style: dashed; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .category-proposal__done { margin-inline-start: auto; padding: 5px; border-radius: 50%; background: var(--a08); }
  .category-proposal__destination {
    align-items: center; justify-content: flex-start; gap: 8px; padding: 6px 9px;
    border-radius: 8px; background: var(--a06);
    > svg { flex: none; color: var(--a-ink); }
  }
  .category-proposal__path {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; min-width: 0; color: var(--assistant-muted);
    span:last-child { color: var(--assistant-ink); font-weight: 600; }
    i { margin-inline-end: 4px; font-style: normal; color: var(--assistant-muted); }
  }
  h4 { margin: 0 0 4px; font-size: 11px; color: var(--a-ink); }
  .category-proposal__list { max-height: 16rem; overflow-y: auto; display: grid; gap: 10px; }
  small { flex: none; color: var(--assistant-muted); font-variant-numeric: tabular-nums; }
  ul { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }
  li { display: flex; justify-content: space-between; gap: 12px; }
  .category-proposal__actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { border: 0; border-radius: 7px; padding: 4px 12px; font: inherit; cursor: pointer; color: var(--a-ink); background: var(--a-soft); }
  button:disabled { opacity: .55; }
}
</style>
