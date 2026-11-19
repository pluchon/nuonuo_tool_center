<template>
  <Transition name="nn-dlg">
    <div v-if="open" class="confirm-dlg" @click="$emit('cancel')">
      <section
        class="confirm-dlg__card nn-dlg-panel"
        :class="{ 'confirm-dlg__card--normal': tone === 'normal' }"
        role="alertdialog"
        aria-modal="true"
        :aria-label="title"
        @click.stop
      >
        <div class="confirm-dlg__head">
          <span class="confirm-dlg__icon">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="icon" /></svg>
          </span>
          <h2 class="confirm-dlg__title">{{ title }}</h2>
        </div>
        <div class="confirm-dlg__btns">
          <button ref="cancelRef" class="confirm-dlg__no" type="button" @click="$emit('cancel')">{{ noLabel }}</button>
          <button class="confirm-dlg__ok" type="button" :disabled="busy" @click="$emit('ok')">{{ okLabel }}</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

<script lang="ts" src="./ConfirmDialog.ts"></script>
<style lang="scss" scoped src="./ConfirmDialog.scss"></style>
