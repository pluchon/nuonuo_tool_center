// 查出处的第 1 层：只看文件名和元信息，不调云端（设计 6.5）。能确定的直接成为建议，其余当线索带给看图

// 从文件名和元信息里得到的线索
export interface LocalClues {
  // 能确定的出处链接（来自图站文件名里的作品号）
  source: string | null
  character: string | null
  artist: string | null
  // 相机拍的照片（有机身型号）：不用再联网查出处
  photo: boolean
  // 给模型看的线索文字（一行一条）
  notes: string[]
}

// 元信息里会用到的几项（来自 image.exif）
export interface ClueExif {
  make?: string
  model?: string
}

// 额外补充线索：相对路径与本地 WD 特征
export interface LocalClueOptions {
  relPath?: string | null
  visualHints?: {
    tags?: string[]
    characters?: Array<{ name: string; score: number }>
  } | null
}

const GENERIC_FOLDERS = new Set([
  'pics', 'images', 'img', 'pictures', 'photos', 'downloads', 'download',
  'desktop', 'source', 'category', 'library', 'wallpaper', 'wallpapers',
  'anime', 'illust', 'illustration', 'nsfw', 'sfw', 'r18',
  '二次元', '壁纸', '图库', '图片', '收藏', '未分类', '其他', '默认', '新建文件夹', '桌面', '下载'
])

const DISTINCTIVE_EXACT_TAGS = new Set([
  'ahoge', 'antenna_hair', 'twintails', 'ponytail', 'side_ponytail', 'high_ponytail', 'low_ponytail',
  'braid', 'braids', 'twin_braids', 'single_braid', 'french_braid', 'hair_bun', 'double_bun', 'odango',
  'bob_cut', 'hime_cut', 'drill_hair', 'twin_drills', 'sidelocks', 'hair_over_one_eye', 'half_updo',
  'hair_intakes', 'blunt_bangs', 'parted_bangs', 'streaked_hair', 'multicolored_hair', 'gradient_hair',
  'two-tone_hair', 'heterochromia', 'constricted_pupils', 'slit_pupils', 'symbol-shaped_pupils',
  'star-shaped_pupils', 'heart-shaped_pupils', 'cross-shaped_pupils', 'flower-shaped_pupils',
  'ringed_eyes', 'empty_eyes', 'glowing_eyes', 'tareme', 'tsurime', 'eyepatch', 'mole_under_eye',
  'pointy_ears', 'long_ears', 'elf', 'horns', 'single_horn', 'tail', 'multiple_tails', 'wings',
  'halo', 'mechanical_halo', 'glasses', 'round_eyewear', 'semi-rimless_eyewear', 'sunglasses',
  'headband', 'hairband', 'hair_ornament', 'hair_flower', 'hair_ribbon', 'hair_bow', 'hairpin',
  'hairclip', 'hair_bobbles', 'hair_bell', 'hair_rings', 'maid_headdress', 'head_wings', 'hat',
  'witch_hat', 'beret', 'cap', 'crown', 'tiara', 'veil', 'headphones', 'cat_ear_headphones', 'mask',
  'blindfold', 'school_uniform', 'sailor_collar', 'serafuku', 'blazer', 'maid', 'maid_apron', 'nurse',
  'nun', 'miko', 'kimono', 'yukata', 'japanese_clothes', 'chinese_clothes', 'china_dress', 'qipao',
  'dress', 'wedding_dress', 'sundress', 'gothic_lolita', 'lolita_fashion', 'armor', 'armour',
  'bodysuit', 'plugsuit', 'military_uniform', 'suit', 'cape', 'cloak', 'hoodie', 'coat', 'witch',
  'sword', 'katana', 'greatsword', 'spear', 'polearm', 'lance', 'scythe', 'bow_(weapon)', 'gun',
  'rifle', 'pistol', 'handgun', 'staff', 'wand', 'magic_wand', 'umbrella', 'parasol',
  'japanese_umbrella', 'fan', 'folding_fan', 'guitar', 'violin', 'microphone', 'book', 'grimoire',
  'shield', 'knife', 'dagger', 'hammer', 'axe', 'lantern'
])

const DISTINCTIVE_TAG_RE = /(?:_hair|_eyes|_ears|_horns|_tail|_wings|_uniform|_dress|_kimono|_hat|_ribbon|_bow|_flower|_ornament|_glasses|_eyewear|_pupils)$/

function meaningfulFolders(relPath: string | null | undefined): string[] {
  if (!relPath) return []
  const parts = relPath.split(/[/\\]/).map((s) => s.trim()).filter(Boolean)
  if (parts.length <= 1) return []
  parts.pop()
  return parts.filter((seg) => !GENERIC_FOLDERS.has(seg.toLowerCase()) && !/^\d+(?:[-_.]\d+)*$/.test(seg))
}

function pickDistinctiveTags(tags: string[]): string[] {
  const picked: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    if (!tag || seen.has(tag)) continue
    if (DISTINCTIVE_EXACT_TAGS.has(tag) || DISTINCTIVE_TAG_RE.test(tag)) {
      seen.add(tag)
      picked.push(tag)
      if (picked.length >= 12) break
    }
  }
  return picked
}

// 图站命名里的下划线换回空格，去掉括号里的作品名，如 ganyu_(genshin_impact) → ganyu
function danbooruName(raw: string): string {
  return raw.replace(/_\([^)]*\)/g, '').replace(/_/g, ' ').trim()
}

// 看文件名、元信息、目录与本地模型视觉线索
export function localClues(fileName: string | null, exif: unknown, options?: LocalClueOptions): LocalClues {
  const out: LocalClues = { source: null, character: null, artist: null, photo: false, notes: [] }
  const safeName = fileName ?? ''
  const base = safeName.replace(/\.[^.]+$/, '')

  // Pixiv 下载：12345678_p0、12345678_p0_master1200
  const pixiv = /^(\d{6,10})_p\d+(?:_master\d+)?$/i.exec(base)
  if (pixiv) {
    out.source = `https://www.pixiv.net/artworks/${pixiv[1]}`
    out.notes.push(`文件名是 Pixiv 作品 ${pixiv[1]} 的下载`)
  }
  // Danbooru / Gelbooru 下载：__角色_(作品)_drawn_by_画师__md5
  const booru = /^__(.+?)_drawn_by_(.+?)__[0-9a-f]{32}$/i.exec(base)
  if (booru) {
    const chars = booru[1].split('_and_').map(danbooruName).filter(Boolean)
    out.character = chars[0] ?? null
    out.artist = danbooruName(booru[2])
    out.notes.push(`文件名来自图站：角色 ${chars.join('、')}，画师 ${out.artist}`)
  }
  // yande.re / konachan 下载：yande.re 12345 tag tag
  const yande = /^(yande\.re|konachan\.com)\s+(\d+)\b/i.exec(base)
  if (yande) {
    const host = yande[1].toLowerCase()
    out.source = `https://${host}/post/show/${yande[2]}`
    out.notes.push(`文件名是 ${host} 的 ${yande[2]} 号作品`)
  }
  // 有相机型号的基本是自己拍的
  const exifObj = exif && typeof exif === 'object' ? (exif as ClueExif) : null
  const camera = [exifObj?.make, exifObj?.model].filter((v) => typeof v === 'string' && v.trim()).join(' ').trim()
  if (camera) {
    out.photo = true
    out.notes.push(`照片的拍摄机身：${camera}`)
  }
  if (out.notes.length === 0 && safeName) {
    out.notes.push(`文件名：${safeName}`)
  }

  const folders = meaningfulFolders(options?.relPath)
  if (folders.length > 0) {
    out.notes.push(`目录线索：${folders.join(' / ')}`)
  }

  const chars = (options?.visualHints?.characters ?? [])
    .filter((c) => c && typeof c.name === 'string' && c.name.trim() && typeof c.score === 'number')
    .slice(0, 5)
    .map((c) => `${c.name.replace(/_/g, ' ').trim()} ${Math.round(c.score * 100)}%`)
  if (chars.length > 0) {
    out.notes.push(`本地模型候选角色（仅供参考，请结合画面细节与联网搜索核实后再采用）：${chars.join('、')}`)
  }

  const distinctive = pickDistinctiveTags(options?.visualHints?.tags ?? [])
  if (distinctive.length > 0) {
    out.notes.push(`本地模型视觉特征：${distinctive.join('、')}`)
  }

  return out
}
