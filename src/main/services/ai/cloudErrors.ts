import OpenAI from 'openai'
import { BizError } from '../../common/bizError'
import { getLogger } from '../../common/logger'

const log = getLogger('ai')

// 云端调用失败统一映射成可展示给用户的 BizError，原始异常细节只写入主进程日志。
export function classifyCloudError(err: unknown): BizError {
  if (err instanceof BizError) return err
  log.warn('诺诺调用云端失败', err)
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new BizError('DEPENDENCY_FAILED', '云端拒绝了请求，请检查百炼 API Key')
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new BizError('DEPENDENCY_FAILED', '云端太忙了，等一会儿再试')
  }
  return new BizError('DEPENDENCY_FAILED', '网络异常')
}
