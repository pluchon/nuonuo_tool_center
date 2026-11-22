// 本地分级的工作进程（Electron utilityProcess）：在这里加载 WD 模型推理，不卡主进程；
// 进程优先级调低、只用 CPU，你在用软件时 3 线程，软件不在前台或电脑没人用时主进程会让它用 4 线程（核显笔记本曾整机卡死，不开 DirectML）
import { constants, setPriority } from 'node:os'
import sharp from 'sharp'
import { WdTagger } from '../services/rating/wdTagger'
import type { RatingRequest, RatingResponse } from '../services/rating/ratingProtocol'

let tagger: WdTagger | null = null
let taggerThreads = 0
let loading: Promise<WdTagger> | null = null

// 懒加载模型，同时只加载一次；线程数变了（电脑空闲 / 有人在用）就释放旧的按新线程数重新加载
async function getTagger(modelDir: string, threads: number): Promise<WdTagger> {
  if (tagger && taggerThreads === threads) {
    return tagger
  }
  if (tagger) {
    const old = tagger
    tagger = null
    await old.dispose()
  }
  loading ??= WdTagger.load(modelDir, { executionProviders: ['cpu'], threads })
    .then((t) => {
      tagger = t
      taggerThreads = threads
      return t
    })
    .finally(() => {
      loading = null
    })
  return loading
}

// 回一条消息给主进程
function reply(msg: RatingResponse): void {
  process.parentPort.postMessage(msg)
}

// sharp 默认缓存读过的文件，Windows 上会一直占着缩略图，清理缓存、删图时报 EBUSY；关掉缓存，读完就放手
sharp.cache(false)
// libvips 自己的线程也压到 1 个，CPU 留给界面
sharp.concurrency(1)

try {
  setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
} catch {
  // 调不了优先级（权限）时照常运行
}

// 一次只处理一条：主进程等上一条回来才发下一条
process.parentPort.on('message', (event) => {
  const req = event.data as RatingRequest
  void (async () => {
    try {
      const t = await getTagger(req.modelDir, req.threads)
      const p = await t.predict(req.file)
      reply({ id: req.id, ok: true, scores: p.ratingScores })
    } catch (err) {
      reply({ id: req.id, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    }
  })()
})
