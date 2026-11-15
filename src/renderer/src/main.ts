import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@fontsource/nunito/400.css'
import '@fontsource/nunito/600.css'
import '@fontsource/nunito/700.css'
import App from './App.vue'
import { router } from './router'
import './styles/global.scss'

createApp(App).use(createPinia()).use(router).use(ElementPlus).mount('#app')
