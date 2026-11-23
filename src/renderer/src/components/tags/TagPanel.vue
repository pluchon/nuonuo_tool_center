<template>
  <aside class="tag-panel" aria-label="标签操作">
    <div class="tag-panel__block">
      <div class="tag-panel__row">
        <label class="tag-panel__label" for="tagNameInput">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" :stroke="color.ink" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><path d="M8 8h.01" /></svg>
          标签名
        </label>
        <div class="tag-panel__acts">
          <template v-if="!creating && tag">
            <button
              class="tag-panel__pill"
              type="button"
              :style="{ borderColor: color.line, background: color.bg, color: color.ink }"
              @click="$emit('view-images', tag.id)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
              {{ tag.count }} 张 ›
            </button>
            <button class="tag-panel__pill tag-panel__pill--del" type="button" aria-label="删除这个标签" @click="$emit('delete', tag.id)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
              删除
            </button>
          </template>
          <template v-if="creating">
            <span class="tag-panel__badge">新建中</span>
            <button class="tag-panel__pill tag-panel__pill--cancel" type="button" @click="$emit('cancel')">取消</button>
          </template>
        </div>
      </div>
      <label class="tag-panel__name" for="tagNameInput" :style="{ borderColor: nameOver ? 'var(--c-b-A23D62)' : color.line }">
        <span class="tag-panel__stripe" :style="{ background: color.ink }" aria-hidden="true" />
        <input
          id="tagNameInput"
          class="tag-panel__name-input"
          :value="name"
          placeholder="输入标签名"
          :style="{ caretColor: color.ink }"
          @input="onNameInput"
          @keydown.enter="!$event.isComposing && save()"
        />
        <span class="tag-panel__len" :class="{ 'tag-panel__len--over': nameOver }">{{ nameOver ? `最多 ${max} 个字 · ` : '' }}{{ nameLen }}/{{ max }}</span>
        <span class="tag-panel__pen" :style="{ background: color.bg, color: color.ink }" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z" /><path d="M14 8l2 2" /></svg>
        </span>
      </label>
    </div>

    <div class="tag-panel__section tag-panel__section--kind">
      <span class="tag-panel__title">分类</span>
      <div ref="kindRef" class="tag-panel__kind-wrap">
        <button
          class="tag-panel__kind"
          type="button"
          aria-haspopup="listbox"
          :aria-expanded="kindOpen"
          :style="{ borderColor: color.line, background: color.bg, color: color.ink }"
          @click="toggleKind"
        >
          <span class="tag-panel__dot" :style="{ background: color.ink }" aria-hidden="true" />
          <span class="tag-panel__kind-name">{{ categoryName }}</span>
          <span class="tag-panel__caret">▾</span>
        </button>
        <Transition name="nn-pop">
          <div v-if="kindOpen" class="tag-panel__pop tag-panel__pop--kind" role="listbox" aria-label="分类">
            <button
              v-for="c in tagsStore.categories"
              :key="c.id"
              class="tag-panel__opt"
              type="button"
              role="option"
              :aria-selected="c.id === categoryId"
              :style="
                c.id === categoryId
                  ? { background: tagsStore.colorOf(c.id).bg, color: tagsStore.colorOf(c.id).ink, borderColor: tagsStore.colorOf(c.id).line }
                  : undefined
              "
              @click="pickKind(c.id)"
            >
              <span class="tag-panel__dot" :style="{ background: tagsStore.colorOf(c.id).dot }" aria-hidden="true" />
              <span class="tag-panel__opt-name">{{ c.name }}</span>
              <span>{{ c.id === categoryId ? '✓' : '' }}</span>
            </button>
          </div>
        </Transition>
      </div>
    </div>

    <div class="tag-panel__section tag-panel__section--col">
      <span class="tag-panel__title">别名</span>
      <div class="tag-panel__alias-box">
        <div v-if="aliases.length" class="tag-panel__aliases">
          <span v-for="a in aliases" :key="a" class="tag-panel__alias">
            {{ a }}
            <button class="tag-panel__alias-x" type="button" aria-label="删除别名" @click="removeAlias(a)">✕</button>
          </span>
        </div>
        <label class="tag-panel__alias-add">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span class="tag-panel__sr">添加别名</span>
          <input class="tag-panel__alias-input" placeholder="输入别名，回车添加" :value="aliasDraft" @input="onAliasInput" @keydown="onAliasKey" />
        </label>
      </div>
    </div>

    <div v-if="!creating && tag && tagsStore.tags.length > 1" class="tag-panel__section tag-panel__section--col tag-panel__section--merge">
      <div class="tag-panel__row">
        <span class="tag-panel__title">合并</span>
        <div class="tag-panel__modes" role="tablist" aria-label="合并方向">
          <button
            v-for="m in modes"
            :key="m.key"
            class="tag-panel__mode"
            :class="{ 'tag-panel__mode--on': mergeMode === m.key }"
            type="button"
            role="tab"
            :aria-selected="mergeMode === m.key"
            @click="pickMode(m.key)"
          >
            {{ m.label }}
          </button>
        </div>
      </div>
      <div ref="mergeRef" class="tag-panel__merge-wrap">
        <button
          class="tag-panel__merge"
          :class="{ 'tag-panel__merge--open': mergeOpen }"
          type="button"
          aria-haspopup="listbox"
          :aria-expanded="mergeOpen"
          @click="toggleMerge"
        >
          <span class="tag-panel__chosen">
            <span v-if="chosen.length === 0" class="tag-panel__placeholder">{{ mergeMode === 'out' ? '选择想要并入哪个标签' : '选择要合并进来的标签' }}</span>
            <span
              v-for="c in chosen"
              :key="c.id"
              class="tag-panel__chip"
              :style="{ '--shape-bg': tagsStore.colorOf(c.categoryId).line, color: tagsStore.colorOf(c.categoryId).ink }"
              >{{ c.name }}</span
            >
          </span>
          <span v-if="mergeMode === 'in'" class="tag-panel__counter">{{ chosen.length }}/{{ mergeMax }}</span>
          <span class="tag-panel__caret">▾</span>
        </button>
        <Transition name="nn-pop">
          <div v-if="mergeOpen" class="tag-panel__pop tag-panel__pop--merge" role="listbox" :aria-multiselectable="mergeMode === 'in'">
            <button
              v-for="o in mergeOptions"
              :key="o.tag.id"
              class="tag-panel__mopt"
              :class="{ 'tag-panel__mopt--on': o.on }"
              type="button"
              role="option"
              :aria-selected="o.on"
              @click="pickMerge(o.tag.id)"
            >
              <span
                class="tag-panel__mark"
                :class="{ 'tag-panel__mark--radio': mergeMode === 'out', 'tag-panel__mark--on': o.on, 'tag-panel__mark--blocked': o.blocked }"
                >{{ o.on ? '✓' : '' }}</span
              >
              <span class="tag-panel__mdot" :style="{ background: o.color.dot }" aria-hidden="true" />
              <span class="tag-panel__mname">{{ o.tag.name }}</span>
              <span class="tag-panel__mcount">{{ o.tag.count }} 张</span>
            </button>
          </div>
        </Transition>
      </div>
      <div v-if="mergePreview" class="tag-panel__preview">
        <span class="tag-panel__preview-text">{{ mergePreview.text }}</span>
        <span class="tag-panel__preview-count">{{ mergePreview.count }} 张图迁移</span>
      </div>
    </div>

    <div class="tag-panel__foot">
      <button class="tag-panel__save" type="button" :disabled="!canSave" @click="save">{{ saveLabel }}</button>
    </div>
  </aside>
</template>

<script lang="ts" src="./TagPanel.ts"></script>
<style lang="scss" scoped src="./TagPanel.scss"></style>
