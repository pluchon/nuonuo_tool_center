<template>
  <div v-if="toast.visible" :key="toast.seq" class="app-toast" :class="{ 'app-toast--error': isError }" role="status">
    <span class="app-toast__icon" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path :d="isError ? 'M12 7v6M12 17h.01' : 'M6 12.5l4 4 8-9'" /></svg>
    </span>
    <span class="app-toast__text">{{ toast.text }}</span>
    <template v-if="isError">
      <span class="app-toast__sep" aria-hidden="true" />
      <button class="app-toast__btn" type="button" @click="toast.close()">知道了</button>
    </template>
    <span v-else class="app-toast__pad" aria-hidden="true" />
  </div>
</template>

<script lang="ts" src="./AppToast.ts"></script>
<style lang="scss" scoped src="./AppToast.scss"></style>
