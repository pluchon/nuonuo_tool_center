import { defineComponent } from 'vue'
import nonoArt from '@/assets/nono/nono-rain.webp'

// 诺诺头像（从书屋插画里裁出脸部）加一句对话气泡，用来播报状态
export default defineComponent({
  name: 'NonoBubble',
  props: {
    message: { type: String, required: true },
    compact: { type: Boolean, default: false }
  },
  setup() {
    const avatarStyle = { backgroundImage: `url(${nonoArt})` }
    return { avatarStyle }
  }
})
