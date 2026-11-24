// 本地分级模型（WD swinv2 tagger v3）放在数据目录的 models 下；第一次要用时在后台下载，断了下次接着下
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getLogger } from '../../common/logger'

const log = getLogger('rating')

export const MODEL_NAME = 'wd-swinv2-tagger-v3'
// 先下小的标签表，再下模型
const FILES = ['selected_tags.csv', 'model.onnx'] as const
// 官方地址不通时换国内镜像
const SOURCES = ['https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/resolve/main/', 'https://hf-mirror.com/SmilingWolf/wd-swinv2-tagger-v3/resolve/main/']
// 下载完的文件至少这么大才算完整（模型约 467 MB，标签表约 300 KB）
const MIN_BYTES: Record<(typeof FILES)[number], number> = { 'selected_tags.csv': 100_000, 'model.onnx': 400_000_000 }

let pending: Promise<boolean> | null = null

// 这个模型的目录
export function modelDirOf(modelsRoot: string): string {
  return join(modelsRoot, MODEL_NAME)
}

// 模型文件都在、大小对得上
export async function isModelReady(modelsRoot: string): Promise<boolean> {
  const dir = modelDirOf(modelsRoot)
  for (const f of FILES) {
    const s = await stat(join(dir, f)).catch(() => null)
    if (!s || s.size < MIN_BYTES[f]) {
      return false
    }
  }
  return true
}

// 先写临时文件，校验后再替换缺失或损坏的正式文件。
async function downloadOne(base: string, dir: string, file: (typeof FILES)[number], signal?: AbortSignal): Promise<void> {
  const target = join(dir, file)
  if (((await stat(target).catch(() => null))?.size ?? 0) >= MIN_BYTES[file]) {
    return
  }
  const part = `${target}.part`
  const have = (await stat(part).catch(() => null))?.size ?? 0
  let res = await fetch(base + file, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal })
  if (have && res.status === 416) {
    await res.body?.cancel()
    res = await fetch(base + file, { signal })
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel()
    throw new Error(`下载 ${file} 失败：HTTP ${res.status}`)
  }
  // 服务器不支持续传时从头下
  const append = res.status === 206
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '')
  if (append && (!range || Number(range[1]) !== have || Number(range[2]) !== Number(range[3]) - 1)) {
    await res.body.cancel()
    throw new Error(`${file} 的续传范围不一致`)
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part, { flags: append ? 'a' : 'w' }), { signal })
  const size = (await stat(part)).size
  if (size < MIN_BYTES[file] || (append && size !== Number(range![3]))) {
    throw new Error(`${file} 只下到 ${size} 字节，不完整`)
  }
  await rename(part, target)
}

// 确保模型在本地：缺了就下载（同时只下一份）；成功返回 true，失败只记日志返回 false
export function ensureModel(modelsRoot: string, signal?: AbortSignal): Promise<boolean> {
  pending ??= (async () => {
    if (await isModelReady(modelsRoot)) {
      return true
    }
    const dir = modelDirOf(modelsRoot)
    await mkdir(dir, { recursive: true })
    log.info(`本地分级模型不在，开始下载到 ${dir}`)
    for (const file of FILES) {
      let done = false
      for (const base of SOURCES) {
        if (signal?.aborted) return false
        try {
          await downloadOne(base, dir, file, signal)
          done = true
          break
        } catch (err) {
          if (signal?.aborted) return false
          log.warn(`从 ${new URL(base).host} 下载 ${file} 失败`, err)
        }
      }
      if (!done) {
        return false
      }
    }
    log.info('本地分级模型下载完成')
    return isModelReady(modelsRoot)
  })().finally(() => {
    pending = null
  })
  return pending
}
