import { randomUUID } from 'node:crypto'
import OSS from 'ali-oss'
import sharp from 'sharp'
import { OSS_CONFIG, readCloudCredentials } from '../../config/cloudConfig'

// 上传前的缩图上限（长边像素）与 JPEG 质量
const MAX_EDGE = 1536
const JPEG_QUALITY = 85

// 一次临时上传的句柄：签名 URL 用于给云端读取，用完必须调用 remove
export interface TempUpload {
  key: string
  signedUrl: string
  bytes: number
  remove: () => Promise<void>
}

let client: OSS | null = null

// 懒加载 OSS 客户端；凭证缺失时明确报错
function getClient(): OSS {
  if (client) {
    return client
  }
  const cred = readCloudCredentials()
  if (!cred.aliyunAccessKeyId || !cred.aliyunAccessKeySecret) {
    throw new Error('缺少环境变量 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET')
  }
  client = new OSS({
    region: OSS_CONFIG.region,
    bucket: OSS_CONFIG.bucket,
    accessKeyId: cred.aliyunAccessKeyId,
    accessKeySecret: cred.aliyunAccessKeySecret,
    secure: true
  })
  return client
}

// 日期目录 yyyyMMdd，便于生命周期规则与排查
function datePrefix(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

// 缩图、转 JPEG（sharp 默认不保留 EXIF），以私有 ACL 上传到临时前缀，返回限时签名 URL
export async function uploadTempImage(filePath: string): Promise<TempUpload> {
  const buffer = await sharp(filePath, { animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()
  const oss = getClient()
  const key = `${OSS_CONFIG.tempPrefix}${datePrefix()}/${randomUUID()}.jpg`
  await oss.put(key, buffer, { headers: { 'x-oss-object-acl': 'private', 'Content-Type': 'image/jpeg' } })
  const signedUrl = oss.signatureUrl(key, { expires: OSS_CONFIG.signedUrlTtlSeconds })
  return {
    key,
    signedUrl,
    bytes: buffer.length,
    remove: async () => {
      await oss.delete(key)
    }
  }
}

// 确认对象已不存在（删除后自检用）
export async function tempObjectExists(key: string): Promise<boolean> {
  try {
    await getClient().head(key)
    return true
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return false
    }
    throw err
  }
}
