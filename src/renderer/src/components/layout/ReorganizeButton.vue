<template>
  <button
    class="reorganize"
    :class="{ 'reorganize--waiting': waiting }"
    type="button"
    :aria-disabled="waiting || busy ? 'true' : undefined"
    @click="org.openReorganize()"
  >
    <svg
      v-if="busy"
      class="reorganize__spinner"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5" opacity="0.25" />
      <path d="M7 2a5 5 0 0 1 5 5" stroke-linecap="round" />
    </svg>
    <svg
      v-else
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
    重新整理
  </button>
  <Teleport to="body">
    <ReorganizeDialog />
  </Teleport>
</template>

<script lang="ts" src="./ReorganizeButton.ts"></script>
<style lang="scss" scoped src="./ReorganizeButton.scss"></style>
