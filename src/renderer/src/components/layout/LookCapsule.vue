<template>
  <div class="look" data-look-pop>
    <button
      ref="pillRef"
      class="look__pill"
      :class="{ 'look__pill--open': look.open }"
      type="button"
      :aria-expanded="look.open"
      aria-haspopup="dialog"
      @click="look.toggle()"
    >
      <svg :class="{ 'nn-gem': look.busy }" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="nnStarPill" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#5B8DEF" />
            <stop offset="0.55" style="stop-color: var(--a)" />
            <stop offset="1" stop-color="#E07BA5" />
          </linearGradient>
        </defs>
        <path :d="starPath" fill="url(#nnStarPill)" />
      </svg>
      {{ look.waitingForKey ? '看图待配置' : look.busy ? '诺诺在看图' : '看图队列' }}
      <span class="look__badge">{{ look.count }}</span>
    </button>

    <!-- 队列卡片一次显示四行，空队列显示诺诺插画 -->
    <Transition name="nn-pop">
      <div v-if="look.open" class="look__card" role="dialog" aria-label="看图队列">
        <span class="look__caret" aria-hidden="true" />
        <div class="look__inner">
          <div class="look__head">
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <defs>
                <linearGradient id="nnStarCard" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="#5B8DEF" />
                  <stop offset="0.55" style="stop-color: var(--a)" />
                  <stop offset="1" stop-color="#E07BA5" />
                </linearGradient>
              </defs>
              <path :d="starPath" fill="url(#nnStarCard)" />
            </svg>
            <span class="look__title">看图队列</span>
            <span class="look__badge">{{ look.count }}</span>
            <button v-if="canCancel" class="look__cancel" type="button" @click="look.cancelAll()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>取消看图任务
            </button>
          </div>
          <span class="look__rule" aria-hidden="true" />
          <div class="look__list nn-thin">
            <div v-if="!look.rows.length" class="look__empty">
              <NonoArt pose="empty" size="small" />
            </div>
            <div v-for="r in look.rows" :key="r.jobId" class="look__row">
              <span class="look__thumb" :style="{ backgroundImage: `url(&quot;${thumbUrl(r.hash)}&quot;)` }" aria-hidden="true" />
              <span class="look__name-wrap">
                <span class="look__name">{{ r.name }}</span>
                <span v-if="r.error" class="look__err">{{ r.error }}</span>
              </span>
              <span v-if="r.state === 'RUNNING'" class="look__run nn-shine">看图中</span>
              <span v-else-if="r.state === 'BATCH'" class="look__wait">{{ look.needsApiKey ? '批量任务待配置密钥' : '批量处理中' }}</span>
              <span v-else-if="r.state === 'QUEUED'" class="look__wait">{{ look.needsApiKey ? '等待配置密钥' : '等待中…' }}</span>
              <button v-else class="look__retry" type="button" aria-label="重试" @click="look.retry(r.jobId)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script lang="ts" src="./LookCapsule.ts"></script>
<style lang="scss" scoped src="./LookCapsule.scss"></style>
