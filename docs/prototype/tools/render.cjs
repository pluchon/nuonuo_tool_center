// 应用原型的本地静态预览：把 AiMain.dc.html 的模板按 renderVals() 展开成普通 HTML，只看样式，不带交互。
// 用法：
//   node docs/prototype/tools/render.cjs                 渲染全部预设到 test-output/prototype/
//   node docs/prototype/tools/render.cjs <名字> '<state-json>' [scene]   渲染一个自定义状态
// 预设名见下方 PRESETS；state 的字段就是 AiMain.dc.html 里 this.state 的字段（如 page、set.theme、set.bg、viewer、setOpen）。
// 生成的 .html 直接用浏览器打开即可（字体从 Google Fonts 加载，离线时退回系统字体）。
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.resolve(__dirname, '../../../test-output/prototype')
const SRC = path.join(ROOT, 'AiMain.dc.html')

// 画布上传的图片（/_blob/<id>）换成仓库里对应的文件，相对 test-output/prototype/
const BLOBS = {
  '0622a7c355ef5d887fc6a6005f83e5f3': '../../src/renderer/src/assets/brand/app-icon.png',
  b0ab6ce76dbbeb61ff791f106a6cf44d: '../../src/renderer/src/assets/nono/welcome.webp',
  '20406dab7373dc5efa41ae653f152aa0': '../../src/renderer/src/assets/nono/empty.webp',
  '02fcdc67981742029bd848f5deb8e629': '../../src/renderer/src/assets/nono/db-error.webp'
}

const PRESETS = {
  'main-light': [{}, ''],
  'main-dark': [{ set: { theme: 'dark' } }, ''],
  'halftone-light': [{ set: { bg: 'halftone' } }, ''],
  'halftone-dark': [{ set: { bg: 'halftone', theme: 'dark' } }, ''],
  'plotter-light': [{ set: { bg: 'plotter' } }, ''],
  'paper-dark': [{ set: { bg: 'paper', theme: 'dark', accent: '#3F8F7B' } }, ''],
  'multi-select': [{ multi: [9, 11, 12] }, ''],
  'viewer': [{ viewer: true }, ''],
  'settings-look': [{ setOpen: true }, ''],
  'settings-general': [{ setOpen: true, set: { tab: 'general' } }, ''],
  'settings-library': [{ setOpen: true, set: { tab: 'library' } }, ''],
  'settings-data': [{ setOpen: true, set: { tab: 'data' } }, ''],
  'settings-keys': [{ setOpen: true, set: { tab: 'keys' } }, ''],
  'settings-about': [{ setOpen: true, set: { tab: 'about' } }, ''],
  'tags': [{ page: 'tags' }, ''],
  'tags-dark': [{ page: 'tags', set: { theme: 'dark' } }, ''],
  'state-first': [{}, 'first'],
  'state-scanning': [{}, 'scanning'],
  'state-offline': [{}, 'offline'],
  'state-broken': [{}, 'broken'],
  'state-noresult': [{}, 'noresult'],
  'state-opfail': [{}, 'opfail'],
  'state-dberror': [{}, 'dberror'],
  'ai-chat': [{}, 'aiThinking'],
  'ai-chat-dark': [{ set: { theme: 'dark' } }, 'aiThinking'],
  'ai-new': [{}, 'aiNew'],
  'ai-noresult': [{}, 'aiNoResult'],
  'ai-offline': [{}, 'aiOffline'],
  'ai-nokey': [{}, 'aiNoKey'],
  'ai-viewer': [{}, 'aiViewer'],
  'ai-queue': [{}, 'aiQueue'],
  'ai-queue-empty': [{}, 'aiQueueEmpty'],
  'ai-suggest': [{}, 'aiSuggest'],
  'ai-suggest-dark': [{ set: { theme: 'dark' } }, 'aiSuggest'],
  'ai-suggest-done': [{}, 'aiSuggestDone']
}

function loadComponent(html) {
  const m = /<script[^>]*>([\s\S]*?class Component[\s\S]*?)<\/script>/.exec(html)
  global.setTimeout = () => 0
  global.setInterval = () => 1
  global.clearInterval = () => {}
  return new Function(
    'class DCLogic{constructor(p){this.props=p||{};} setState(o){Object.assign(this.state,o);}}\n' +
      m[1].replace(/^[\s\S]*?(class Component)/, '$1') +
      '\nreturn Component;'
  )()
}

function parseTemplate(html) {
  const body = html.slice(html.indexOf('<x-dc>') + 6, html.indexOf('<script type="text/x-dc"'))
  const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(body)[1]
  const tpl = body.replace(/<helmet>[\s\S]*?<\/helmet>/, '').replace(/<\/x-dc>[\s\S]*$/, '')
  const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr'])
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:@.-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
  const root = { tag: '#root', attrs: [], kids: [] }
  const stack = [root]
  let t
  while ((t = re.exec(tpl))) {
    if (t[0].startsWith('<!--')) continue
    const top = stack[stack.length - 1]
    if (t[5] !== undefined) {
      top.kids.push({ text: t[5] })
      continue
    }
    const [, close, tag, attrs, self] = t
    if (close) {
      while (stack.length > 1 && stack.pop().tag !== tag);
      continue
    }
    const node = { tag, attrs: [], kids: [] }
    const ar = /([\w:@.-]+)(?:="([^"]*)")?/g
    let a
    while ((a = ar.exec(attrs))) node.attrs.push([a[1], a[2] === undefined ? '' : a[2]])
    top.kids.push(node)
    if (!self && !VOID.has(tag.toLowerCase())) stack.push(node)
  }
  return { helmet, root, VOID }
}

function renderPage(html, state, scene) {
  const Component = loadComponent(html)
  const c = new Component({ scene: scene || '' })
  Object.assign(c.state, state)
  const vals = c.renderVals()
  const { helmet, root, VOID } = parseTemplate(html)
  const get = (scope, p) => {
    const parts = p.trim().split('.')
    let v
    for (let i = scope.length - 1; i >= 0; i--) if (parts[0] in scope[i]) { v = scope[i][parts[0]]; break }
    for (const k of parts.slice(1)) v = v == null ? undefined : v[k]
    return v
  }
  const one = (s) => /^\{\{([^}]+)\}\}$/.exec(s.trim())
  const interp = (s, scope) => s.replace(/\{\{([^}]+)\}\}/g, (_, e) => {
    const v = get(scope, e)
    return v == null || typeof v === 'function' ? '' : String(v)
  })
  const BOOL = new Set(['disabled', 'readOnly', 'readonly', 'autofocus', 'checked'])
  const render = (n, scope) => {
    if (n.text !== undefined) return interp(n.text, scope)
    const at = Object.fromEntries(n.attrs)
    if (n.tag === 'sc-if') {
      const mm = one(at.value || '')
      const v = mm ? get(scope, mm[1]) : at.value
      return v && v !== 'false' ? n.kids.map((k) => render(k, scope)).join('') : ''
    }
    if (n.tag === 'sc-for') {
      const list = get(scope, one(at.list)[1]) || []
      return list.map((item) => n.kids.map((k) => render(k, [...scope, { [at.as]: item }])).join('')).join('')
    }
    if (n.tag === '#root') return n.kids.map((k) => render(k, scope)).join('')
    let s = '<' + n.tag
    for (const [k, v] of n.attrs) {
      if (/^on[A-Z]/.test(k) || k.startsWith('hint-')) continue
      const mm = one(v)
      if (mm && BOOL.has(k)) {
        const b = get(scope, mm[1])
        if (b && b !== 'false') s += ' ' + k
        continue
      }
      s += ' ' + k + '="' + interp(v, scope).replace(/"/g, '&quot;') + '"'
    }
    s += '>'
    if (VOID.has(n.tag.toLowerCase())) return s
    return s + n.kids.map((k) => render(k, scope)).join('') + '</' + n.tag + '>'
  }
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + helmet +
    '</head><body style="margin:0;background:#888">' + render(root, [vals]) + '</body></html>'
}

let html = fs.readFileSync(SRC, 'utf8')
for (const [id, file] of Object.entries(BLOBS)) html = html.split('/_blob/' + id).join(file)
fs.mkdirSync(OUT, { recursive: true })
const [, , name, stateJson, scene] = process.argv
const jobs = name ? { [name]: [JSON.parse(stateJson || '{}'), scene || ''] } : PRESETS
for (const [n, [state, sc]] of Object.entries(jobs)) {
  const file = path.join(OUT, n + '.html')
  fs.writeFileSync(file, renderPage(html, state, sc))
  console.log('wrote', path.relative(process.cwd(), file))
}
