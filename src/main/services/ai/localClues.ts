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

// 图站命名里的下划线换回空格，去掉括号里的作品名，如 ganyu_(genshin_impact) → ganyu
function danbooruName(raw: string): string {
  return raw.replace(/_\([^)]*\)/g, '').replace(/_/g, ' ').trim()
}

// 看文件名和元信息
export function localClues(fileName: string, exif: ClueExif | null): LocalClues {
  const out: LocalClues = { source: null, character: null, artist: null, photo: false, notes: [] }
  const base = fileName.replace(/\.[^.]+$/, '')

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
  const camera = [exif?.make, exif?.model].filter((v) => typeof v === 'string' && v.trim()).join(' ').trim()
  if (camera) {
    out.photo = true
    out.notes.push(`照片的拍摄机身：${camera}`)
  }
  if (out.notes.length === 0) {
    out.notes.push(`文件名：${fileName}`)
  }
  return out
}
