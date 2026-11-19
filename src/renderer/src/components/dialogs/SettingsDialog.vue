<template>
  <Transition name="nn-dlg">
    <div v-if="settings.dialogOpen" class="set-dlg" @mousedown="onMaskDown" @click="onMaskClick">
      <section class="set-dlg__card nn-dlg-panel" role="dialog" aria-modal="true" aria-label="设置">
        <div class="set-dlg__head">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <h2 class="set-dlg__title">设置</h2>
          <button ref="closeRef" class="set-dlg__close" type="button" aria-label="关闭" title="关闭（Esc）" @click="close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
          </button>
        </div>

        <div class="set-dlg__body">
          <div class="set-dlg__tabs" role="tablist" aria-label="设置分类" aria-orientation="vertical">
            <button
              v-for="t in tabs"
              :key="t.key"
              class="set-dlg__tab"
              :class="{ 'set-dlg__tab--on': settings.tab === t.key }"
              role="tab"
              :aria-selected="settings.tab === t.key"
              type="button"
              @click="settings.setTab(t.key)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="t.icon" /></svg>{{ t.label }}
            </button>
          </div>

          <!-- 换分类时内容淡入 -->
          <div :key="settings.tab" class="set-dlg__pane nn-noscroll nn-appear">
            <section v-for="g in groups" :key="g.title" class="set-dlg__group" :aria-label="g.title">
              <h3 class="set-dlg__group-title">{{ g.title }}</h3>
              <div
                v-for="(r, i) in g.rows"
                :key="`${g.title}-${i}`"
                class="set-dlg__row"
                :class="{ 'set-dlg__row--stack': r.type === 'bgs', 'set-dlg__row--sep': i > 0 }"
              >
                <span class="set-dlg__label">{{ r.label }}</span>
                <div class="set-dlg__ctl">
                  <button
                    v-if="r.type === 'toggle'"
                    class="set-dlg__switch"
                    :class="{ 'set-dlg__switch--on': settings.values[r.key] }"
                    role="switch"
                    type="button"
                    :aria-checked="settings.values[r.key]"
                    :aria-label="r.label"
                    @click="toggle(r.key)"
                  >
                    <span class="set-dlg__knob"></span>
                  </button>

                  <div v-else-if="r.type === 'seg'" class="set-dlg__seg" role="radiogroup" :aria-label="r.label">
                    <button
                      v-for="o in r.opts"
                      :key="o.value"
                      class="set-dlg__seg-btn"
                      :class="{ 'set-dlg__seg-btn--on': r.value === o.value }"
                      role="radio"
                      type="button"
                      :aria-checked="r.value === o.value"
                      @click="r.pick(o.value)"
                    >
                      {{ o.label }}
                    </button>
                  </div>

                  <template v-else-if="r.type === 'swatch'">
                    <button
                      v-for="a in accents"
                      :key="a.color"
                      class="set-dlg__swatch"
                      type="button"
                      :aria-label="a.label"
                      :title="a.label"
                      :aria-pressed="a.on"
                      :style="{ background: a.color, boxShadow: `0 0 0 2px ${a.on ? a.color : 'transparent'}` }"
                      @click="save({ accent: a.color })"
                    >
                      {{ a.on ? '✓' : '' }}
                    </button>
                  </template>

                  <template v-else-if="r.type === 'bgs'">
                    <button
                      v-for="t in bgTiles"
                      :key="t.key"
                      class="set-dlg__bg"
                      :class="{ 'set-dlg__bg--on': t.on }"
                      type="button"
                      :aria-pressed="t.on"
                      :aria-label="t.empty ? '选一张背景图' : t.label"
                      @click="pickBg(t.key)"
                    >
                      <span class="set-dlg__bg-pic" :class="{ 'set-dlg__bg-pic--empty': t.empty }" :style="{ background: t.bg }">
                        <svg v-if="t.empty" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                        <span
                          v-else-if="t.key === 'custom'"
                          class="set-dlg__bg-swap"
                          role="button"
                          aria-label="更换图片"
                          title="更换图片"
                          @click.stop="replaceBg()"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3M20 4v5h-5M20 12a8 8 0 0 1-14 5.3M4 20v-5h5" /></svg>
                        </span>
                      </span>
                      <span class="set-dlg__bg-label">{{ t.label }}</span>
                    </button>
                  </template>

                  <template v-else-if="r.type === 'range'">
                    <input
                      class="set-dlg__range"
                      type="range"
                      :aria-label="r.label"
                      :min="r.min"
                      :max="r.max"
                      :value="settings.values[r.key]"
                      @input="onRange(r.key, $event)"
                    />
                    <span class="set-dlg__range-val">{{ settings.values[r.key] }}{{ r.unit }}</span>
                  </template>

                  <template v-else-if="r.type === 'chips'">
                    <button
                      v-for="f in formats"
                      :key="f.label"
                      class="set-dlg__chip"
                      :class="{ 'set-dlg__chip--on': f.on }"
                      type="button"
                      :aria-pressed="f.on"
                      @click="toggleFormat(f.label)"
                    >
                      {{ f.label }}
                    </button>
                  </template>

                  <template v-else-if="r.type === 'path'">
                    <span class="set-dlg__path" :title="r.path">{{ r.path || '…' }}</span>
                    <button class="set-dlg__btn" type="button" :disabled="r.disabled" @click="r.run()">{{ r.btn }}</button>
                  </template>

                  <template v-else-if="r.type === 'value'">
                    <span class="set-dlg__value">{{ r.value }}</span>
                    <button v-if="r.btn" class="set-dlg__btn" type="button" :disabled="busy" @click="r.run?.()">{{ r.btn }}</button>
                  </template>

                  <template v-else-if="r.type === 'update'">
                    <span v-if="updateUi.text" class="set-dlg__upd-text">{{ updateUi.text }}</span>
                    <button
                      class="set-dlg__upd"
                      :class="`set-dlg__upd--${update}`"
                      type="button"
                      :aria-label="updateUi.tip"
                      :title="updateUi.tip"
                      @click="runUpdate"
                    >
                      <svg :class="{ 'set-dlg__spin': update === 'checking' }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="updateUi.icon" /></svg>
                    </button>
                    <span class="set-dlg__version">v{{ info?.version ?? '' }}</span>
                  </template>

                  <template v-else-if="r.type === 'kbd'">
                    <kbd v-for="k in r.keys" :key="k" class="set-dlg__kbd">{{ k }}</kbd>
                  </template>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  </Transition>
</template>

<script lang="ts" src="./SettingsDialog.ts"></script>
<style lang="scss" scoped src="./SettingsDialog.scss"></style>
