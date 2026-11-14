<template>
  <div class="home">
    <header class="home__header">
      <h1>本地图库</h1>
      <el-button type="primary" :loading="store.importing" @click="onImport">导入目录</el-button>
    </header>

    <div v-if="store.loading" v-loading="true" class="home__state" />
    <el-result v-else-if="store.error" icon="error" title="加载失败" :sub-title="store.error">
      <template #extra>
        <el-button @click="store.load()">重试</el-button>
      </template>
    </el-result>
    <template v-else>
      <el-empty v-if="store.roots.length === 0" description="还没有导入任何目录" />
      <el-table v-else :data="store.roots" class="home__table">
        <el-table-column prop="name" label="名称" width="220" />
        <el-table-column prop="path" label="路径" />
      </el-table>

      <el-descriptions v-if="store.systemInfo" title="运行环境" :column="2" border class="home__info">
        <el-descriptions-item label="数据库">{{ dbSummary }}</el-descriptions-item>
        <el-descriptions-item label="扩展">{{ store.systemInfo.database.extensions.join(', ') }}</el-descriptions-item>
        <el-descriptions-item label="百炼密钥">{{ yesNo(store.systemInfo.credentials.dashscope) }}</el-descriptions-item>
        <el-descriptions-item label="阿里云 AccessKey">
          {{ yesNo(store.systemInfo.credentials.aliyunAccessKey) }}
        </el-descriptions-item>
        <el-descriptions-item label="数据目录" :span="2">{{ store.systemInfo.dataDir }}</el-descriptions-item>
      </el-descriptions>
    </template>
  </div>
</template>

<script lang="ts" src="./HomeView.ts"></script>
<style lang="scss" scoped src="./HomeView.scss"></style>
