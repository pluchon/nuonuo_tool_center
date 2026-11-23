import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { pickModelFile } from './modelFile'
import { WD_GENERAL_THRESHOLD } from './ratingProtocol'

// WD tagger v3 的输入边长与标签分类编号
const INPUT_SIZE = 448
const CATEGORY_GENERAL = 0
const CATEGORY_CHARACTER = 4
const CATEGORY_RATING = 9

// 分级标签，顺序与模型输出一致
export type WdRating = 'general' | 'sensitive' | 'questionable' | 'explicit'

// 单张图的推理结果
export interface WdPrediction {
  rating: WdRating
  ratingScores: Record<WdRating, number>
  generalTags: Array<{ name: string; score: number }>
  characterTags: Array<{ name: string; score: number }>
}

// 推理选项：通用标签与角色标签阈值
export interface WdPredictOptions {
  generalThreshold?: number
  characterThreshold?: number
}

// 加载选项：执行后端与 CPU 线程数
export interface WdLoadOptions {
  executionProviders?: string[]
  threads?: number
}

interface TagRow {
  name: string
  category: number
}

// 解析 selected_tags.csv（列：tag_id,name,category,count）
function parseTags(csv: string): TagRow[] {
  return csv
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cols = line.split(',')
      return { name: cols[1], category: Number(cols[2]) }
    })
}

// 预处理：透明底铺白、等比缩放后补白成正方形，转为 BGR 的 float32 NHWC 张量（0~255）
async function toInputTensor(filePath: string): Promise<ort.Tensor> {
  const { data } = await sharp(filePath, { animated: false })
    .flatten({ background: '#ffffff' })
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'contain', background: '#ffffff', kernel: 'cubic' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = INPUT_SIZE * INPUT_SIZE
  const floats = new Float32Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    floats[i * 3] = data[i * 3 + 2]
    floats[i * 3 + 1] = data[i * 3 + 1]
    floats[i * 3 + 2] = data[i * 3]
  }
  return new ort.Tensor('float32', floats, [1, INPUT_SIZE, INPUT_SIZE, 3])
}

// WD tagger：本地给图片分级并输出标签，分级结果用作上云闸门
export class WdTagger {
  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly tags: TagRow[]
  ) {}

  // 从模型目录加载（需包含 model.onnx 与 selected_tags.csv，有 int8 版优先用）；默认只用 CPU 且限 2 线程，避免核显机器整机卡死
  static async load(modelDir: string, options: WdLoadOptions = {}): Promise<WdTagger> {
    const { executionProviders = ['cpu'], threads = 2 } = options
    const csv = await readFile(join(modelDir, 'selected_tags.csv'), 'utf8')
    const session = await ort.InferenceSession.create(join(modelDir, pickModelFile(modelDir)), {
      executionProviders: executionProviders as ort.InferenceSession.ExecutionProviderConfig[],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: threads,
      interOpNumThreads: 1
    })
    return new WdTagger(session, parseTags(csv))
  }

  // 对单张图推理
  async predict(filePath: string, options: WdPredictOptions = {}): Promise<WdPrediction> {
    const { generalThreshold = WD_GENERAL_THRESHOLD, characterThreshold = 0.85 } = options
    const input = await toInputTensor(filePath)
    const output = await this.session.run({ [this.session.inputNames[0]]: input })
    const probs = output[this.session.outputNames[0]].data as Float32Array

    const ratingScores = { general: 0, sensitive: 0, questionable: 0, explicit: 0 } as Record<WdRating, number>
    const generalTags: WdPrediction['generalTags'] = []
    const characterTags: WdPrediction['characterTags'] = []
    this.tags.forEach((tag, i) => {
      const score = probs[i]
      if (tag.category === CATEGORY_RATING) {
        ratingScores[tag.name as WdRating] = score
      } else if (tag.category === CATEGORY_GENERAL && score >= generalThreshold) {
        generalTags.push({ name: tag.name, score })
      } else if (tag.category === CATEGORY_CHARACTER && score >= characterThreshold) {
        characterTags.push({ name: tag.name, score })
      }
    })
    const rating = (Object.keys(ratingScores) as WdRating[]).reduce((a, b) => (ratingScores[b] > ratingScores[a] ? b : a))
    generalTags.sort((a, b) => b.score - a.score)
    characterTags.sort((a, b) => b.score - a.score)
    return { rating, ratingScores, generalTags, characterTags }
  }

  // 释放模型
  async dispose(): Promise<void> {
    await this.session.release()
  }
}

// 模型判定为“明显敏感”：questionable 与 explicit 分数之和达到阈值；轻微的 sensitive 不算
export function isObviouslyNsfw(prediction: WdPrediction, threshold = 0.5): boolean {
  return prediction.ratingScores.questionable + prediction.ratingScores.explicit >= threshold
}

// 上云闸门（仅模型分级时使用）：只拦明显敏感的图；用户手动分级优先于此结果
export function isCloudAllowed(prediction: WdPrediction, threshold = 0.5): boolean {
  return !isObviouslyNsfw(prediction, threshold)
}
