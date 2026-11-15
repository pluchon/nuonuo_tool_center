<template>
  <div class="home">
    <div v-if="store.loading" class="home__panel nn-glass">
      <el-skeleton :rows="5" animated />
    </div>

    <div v-else-if="store.error" class="home__panel home__panel--center nn-glass">
      <NonoBubble message="呜…书架没打开，是不是哪里出问题了？" />
      <p class="home__error">{{ store.error }}</p>
      <el-button round @click="store.load()">重试</el-button>
    </div>

    <section v-else-if="store.roots.length === 0" class="home__welcome nn-glass">
      <img class="home__art" :src="nonoArt" alt="雨天里撑着透明伞的诺诺" />
      <div class="home__intro">
        <p class="home__kicker">Rainy day library</p>
        <h1 class="home__title">欢迎来到诺诺的图书馆</h1>
        <p class="home__desc">把图片目录交给诺诺：她会帮你整理、打标签、查出处。删掉的图先进回收站，所有整理都能撤销。</p>
        <div class="home__tags">
          <span class="home__tag home__tag--lilac">只在本机运行</span>
          <span class="home__tag home__tag--sakura">删除可找回</span>
          <span class="home__tag home__tag--lantern">敏感图你说了算</span>
        </div>
        <el-button type="primary" size="large" round :loading="store.importing" @click="onImport">
          导入图片目录
        </el-button>
      </div>
    </section>

    <template v-else>
      <header class="home__header">
        <div>
          <h1 class="home__title home__title--small">全部图片</h1>
          <p class="home__sub">已导入 {{ store.roots.length }} 个目录</p>
        </div>
        <el-button type="primary" round :loading="store.importing" @click="onImport">导入目录</el-button>
      </header>
      <div class="home__roots">
        <article v-for="root in store.roots" :key="root.id" class="home__root nn-glass">
          <div class="home__root-icon"><el-icon><FolderOpened /></el-icon></div>
          <div class="home__root-text">
            <strong>{{ root.name }}</strong>
            <span>{{ root.path }}</span>
          </div>
        </article>
      </div>
      <div class="home__tip nn-glass">
        <NonoBubble compact message="扫描和缩略图还在做哦，做好以后图片会排在这里～" />
      </div>
    </template>
  </div>
</template>

<script lang="ts" src="./HomeView.ts"></script>
<style lang="scss" scoped src="./HomeView.scss"></style>
