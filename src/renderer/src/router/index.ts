import { createRouter, createWebHashHistory } from 'vue-router'

// 路由：桌面应用用 hash 模式，打包后从 file 协议加载也能工作
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', name: 'home', component: () => import('@/views/home/HomeView.vue') }]
})
