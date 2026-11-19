<template>
  <div v-if="open" class="confirm-dlg" @click="$emit('cancel')">
    <section class="confirm-dlg__card" role="alertdialog" aria-modal="true" :aria-label="title" @click.stop>
      <div class="confirm-dlg__head">
        <span class="confirm-dlg__icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </span>
        <h2 class="confirm-dlg__title">{{ title }}</h2>
      </div>
      <div class="confirm-dlg__btns">
        <button ref="cancelRef" class="confirm-dlg__no" type="button" @click="$emit('cancel')">{{ noLabel }}</button>
        <button class="confirm-dlg__ok" type="button" :disabled="busy" @click="$emit('ok')">{{ okLabel }}</button>
      </div>
    </section>
  </div>
</template>

<script lang="ts" src="./ConfirmDialog.ts"></script>
<style lang="scss" scoped src="./ConfirmDialog.scss"></style>
