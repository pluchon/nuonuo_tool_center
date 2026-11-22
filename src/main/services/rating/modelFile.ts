// 选用哪个模型文件：有验证过的 int8 量化版就用它（约快一倍），没有或不完整就用原版
import { statSync } from 'node:fs'
import { join } from 'node:path'

// 原版模型（约 467 MB）
export const MODEL_FILE = 'model.onnx'
// int8 动态量化版（约 175 MB），由 scripts/quantize-model.py 在本地生成
export const INT8_FILE = 'model.int8.onnx'
// int8 文件至少这么大才算完整
const INT8_MIN_BYTES = 150_000_000

// 返回模型目录里要加载的文件名
export function pickModelFile(modelDir: string): string {
  try {
    if (statSync(join(modelDir, INT8_FILE)).size >= INT8_MIN_BYTES) {
      return INT8_FILE
    }
  } catch {
    // 没有 int8 文件
  }
  return MODEL_FILE
}
