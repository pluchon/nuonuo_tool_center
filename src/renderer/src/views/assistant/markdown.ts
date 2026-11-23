import MarkdownIt from 'markdown-it'

// 附件和模型输出仅供阅读。远程图片、链接、原始 HTML 均不创建可交互的网页元素。
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false })
markdown.disable(['image', 'link', 'autolink'])

export function renderMarkdown(text: string): string {
  return markdown.render(text).trimEnd()
}

export function hasMarkdown(text: string): boolean {
  return markdown.parse(text, {}).some((token) => token.type === 'inline'
    ? token.children?.some((child) => !['text', 'softbreak', 'hardbreak'].includes(child.type))
    : token.type !== 'paragraph_open' && token.type !== 'paragraph_close')
}

// 光标处尚未闭合的围栏内，回车应继续输入代码。闭合围栏可以长于开始围栏。
export function insideCodeFence(prefix: string): boolean {
  let fence = ''
  for (const line of prefix.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    const [, marker, rest] = match
    if (!fence) {
      if (marker[0] !== '`' || !rest.includes('`')) fence = marker
    } else if (marker[0] === fence[0] && marker.length >= fence.length && !rest.trim()) {
      fence = ''
    }
  }
  return Boolean(fence)
}
