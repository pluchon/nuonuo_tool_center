<template>
  <div class="image-grid__row">
    <div class="image-grid__tiles"><slot /></div>
  </div>
</template>

<style scoped>
.image-grid__tiles {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 8px;
}
</style>
