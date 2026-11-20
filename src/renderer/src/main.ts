import { createApp } from 'vue'
import { createPinia } from 'pinia'
// Element Plus 只用到树（复制 / 移动对话框）和消息提示：按需引入，不打包整套组件和样式（启动更快）
import { ElTree } from 'element-plus'
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-icon.css'
import 'element-plus/theme-chalk/el-checkbox.css'
import 'element-plus/theme-chalk/el-tree.css'
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@fontsource/nunito/400.css'
import '@fontsource/nunito/600.css'
import '@fontsource/nunito/700.css'
import '@fontsource/nunito/800.css'
import '@fontsource-variable/noto-sans-sc'
import App from './App.vue'
import './styles/global.scss'

createApp(App).use(createPinia()).use(ElTree).mount('#app')
