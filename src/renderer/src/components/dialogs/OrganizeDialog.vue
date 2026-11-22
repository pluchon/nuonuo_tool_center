<template>
  <Transition name="nn-dlg">
    <div v-if="org.dialog" class="org-dlg" @click="org.close()">
      <section
        class="org-dlg__card nn-dlg-panel"
        :class="{ 'org-dlg__card--plan': org.dialog === 'plan' }"
        :role="org.dialog === 'stop' ? 'alertdialog' : 'dialog'"
        aria-modal="true"
        :aria-label="head.title"
        @click.stop
      >
        <!-- 顶部：渐变底、几颗小星星、徽章图标、标题和一句说明，右上角 × 是“先不” -->
        <header class="org-dlg__hero">
          <svg class="org-dlg__deco org-dlg__deco--a" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" /></svg>
          <svg class="org-dlg__deco org-dlg__deco--b" width="9" height="9" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" /></svg>
          <svg class="org-dlg__deco org-dlg__deco--c" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" /></svg>
          <span class="org-dlg__badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="folderPath" /><path v-if="org.dialog !== 'stop'" d="M9 13l2 2 4-4" /></svg>
          </span>
          <div class="org-dlg__heading">
            <h2 class="org-dlg__title">{{ head.title }}</h2>
            <p class="org-dlg__sub">{{ head.sub }}</p>
          </div>
          <button ref="closeRef" class="org-dlg__x" type="button" :aria-label="head.close" @click="org.close()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
          </button>
        </header>

        <!-- 开始前：三格数字、三行说明、一个按钮 -->
        <template v-if="org.dialog === 'confirm' && est">
          <!-- 分级没做完时：张数和花费按剩下的最多都要看来算 -->
          <div class="org-dlg__stats">
            <div class="org-dlg__stat">
              <b>{{ (est.toLook + est.ratingLeft).toLocaleString('zh-CN') }}</b><span>{{ est.ratingLeft > 0 ? '张待看（最多）' : '张待看' }}</span>
            </div>
            <div class="org-dlg__stat">
              <b>{{ tokenText }}</b><span>token</span>
            </div>
            <div class="org-dlg__stat org-dlg__stat--money">
              <b>¥{{ est.yuan.toFixed(2) }}</b><span>约花费</span>
            </div>
          </div>
          <ul class="org-dlg__lines">
            <li v-for="l in lines" :key="l.text">
              <span class="org-dlg__dot"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="l.icon" /></svg></span>{{ l.text }}
            </li>
          </ul>
          <p v-if="est.ratingLeft > 0" class="org-dlg__note">本地分级还剩 {{ est.ratingLeft.toLocaleString('zh-CN') }} 张，判完的半价陆续补进来</p>
          <button class="org-dlg__go" type="button" :disabled="org.busy" @click="org.start()">
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path :d="starPath" fill="currentColor" /></svg>开始整理
          </button>
          <p class="org-dlg__foot">花费是粗估，以账单为准</p>
        </template>

        <!-- 方案：可以改目录名、去掉目录或词 -->
        <template v-else-if="org.dialog === 'plan'">
          <div v-if="org.error" class="org-dlg__error">
            <NonoArt pose="empty" size="small" />
            <p class="org-dlg__error-text">{{ org.error }}</p>
          </div>
          <div v-else class="org-dlg__list nn-thin">
            <div v-for="(f, i) in org.draft" :key="i" class="org-dlg__folder">
              <div class="org-dlg__folder-head">
                <input v-model.trim="f.name" class="org-dlg__name" :maxlength="nameMax" aria-label="目录名" />
                <span class="org-dlg__tag" :class="{ 'org-dlg__tag--new': isNew(f.name) }">{{ isNew(f.name) ? '新建' : '已有' }}</span>
                <button class="org-dlg__del" type="button" aria-label="去掉这个目录" @click="org.removeFolder(i)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
                </button>
              </div>
              <div class="org-dlg__terms">
                <template v-for="k in kinds" :key="k.key">
                  <span v-for="w in f[k.key]" :key="k.key + w" class="org-dlg__term">
                    <span class="org-dlg__term-kind">{{ k.label }}</span>{{ w }}
                    <button class="org-dlg__term-x" type="button" :aria-label="`去掉${w}`" @click="org.removeTerm(i, k.key, w)">×</button>
                  </span>
                </template>
                <span v-if="!f.characters.length && !f.works.length && !f.tags.length" class="org-dlg__empty">没有词了，这个目录不会收图</span>
              </div>
            </div>
          </div>
          <div class="org-dlg__btns">
            <button class="org-dlg__no" type="button" :disabled="org.busy" @click="org.cancel()">不要这个方案</button>
            <button v-if="org.error" class="org-dlg__go" type="button" :disabled="org.busy" @click="org.start()">再试一次</button>
            <button v-else class="org-dlg__go" type="button" :disabled="org.busy || !org.draft.length" @click="org.approve()">按这个方案整理</button>
          </div>
        </template>

        <!-- 进行中再点：停不停 -->
        <template v-else-if="org.dialog === 'stop'">
          <button class="org-dlg__go org-dlg__go--stop" type="button" :disabled="org.busy" @click="org.cancel()">停止整理</button>
        </template>
      </section>
    </div>
  </Transition>
</template>

<script lang="ts" src="./OrganizeDialog.ts"></script>
<style lang="scss" scoped src="./OrganizeDialog.scss"></style>
