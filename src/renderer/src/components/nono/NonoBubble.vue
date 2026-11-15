<template>
  <div class="nono-bubble" :class="{ 'nono-bubble--compact': compact }">
    <div class="nono-bubble__avatar" :style="avatarStyle" role="img" aria-label="诺诺" />
    <div class="nono-bubble__text">
      <span class="nono-bubble__name">诺诺</span>
      <span>{{ message }}</span>
    </div>
  </div>
</template>

<script lang="ts" src="./NonoBubble.ts"></script>
<style lang="scss" scoped src="./NonoBubble.scss"></style>
