import type { HarnessState, ToolEnv, ToolOutcome } from './types'

export type JsonSchemaProperty =
  | { type: 'string'; description?: string; enum?: readonly string[] }
  | { type: 'integer'; description?: string; minimum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; maxItems?: number; items: JsonSchemaProperty }

export interface ObjectSchema {
  type: 'object'
  required?: readonly string[]
  runtimeRequired?: readonly string[]
  properties: Record<string, JsonSchemaProperty>
}

export type ToolSideEffect = 'read' | 'memory' | 'proposal'

export interface ToolExecutionResult {
  content: string
  outcome?: ToolOutcome
}

export interface RegisteredTool {
  name: string
  description: string
  parameters: ObjectSchema
  sideEffect?: ToolSideEffect
  silent?: boolean
  formatStart?: (args: Record<string, unknown>) => string
  formatDone?: (args: Record<string, unknown>, result: ToolExecutionResult) => string
  execute: (args: Record<string, unknown>, env: ToolEnv, state: HarnessState) => Promise<ToolExecutionResult> | ToolExecutionResult
}

export function defineTool(tool: RegisteredTool): RegisteredTool {
  return tool
}

export function parseToolJson(content: string): unknown {
  try {
    return content ? JSON.parse(content) : null
  } catch {
    return null
  }
}

export function isToolError(parsed: unknown): boolean {
  return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).error === 'string')
}

export function truncateLabel(value: unknown, maxChars = 16): string {
  const text = typeof value === 'string' ? value.replace(/[\r\n\s]+/g, ' ').trim() : ''
  if (!text) return ''
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : chars.slice(0, maxChars - 1).join('') + '…'
}

function validateValue(prop: JsonSchemaProperty, val: unknown, path: string): string | null {
  if (prop.type === 'string') {
    if (typeof val !== 'string') return `参数 ${path} 应为字符串`
    if (prop.enum && !prop.enum.includes(val)) return `参数 ${path} 取值不在允许范围内`
    return null
  }
  if (prop.type === 'integer') {
    if (typeof val !== 'number' || !Number.isInteger(val)) return `参数 ${path} 应为整数`
    if (prop.minimum !== undefined && val < prop.minimum) return `参数 ${path} 不能小于 ${prop.minimum}`
    return null
  }
  if (prop.type === 'boolean') {
    if (typeof val !== 'boolean') return `参数 ${path} 应为布尔值`
    return null
  }
  if (prop.type === 'array') {
    if (!Array.isArray(val)) return `参数 ${path} 应为数组`
    if (prop.maxItems !== undefined && val.length > prop.maxItems) return `参数 ${path} 最多 ${prop.maxItems} 项`
    for (let i = 0; i < val.length; i++) {
      const err = validateValue(prop.items, val[i], `${path}[${i}]`)
      if (err) return err
    }
    return null
  }
  return null
}

// 单源 Schema 校验：解析 JSON 并按同一份参数定义校验必填字段和字段类型
export function validateToolArgs(
  schema: ObjectSchema,
  rawArgs: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown = {}
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : {}
  } catch {
    return { ok: false, error: '参数不是合法的 JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '工具参数应为 JSON 对象' }
  }
  const obj = parsed as Record<string, unknown>
  const required = schema.runtimeRequired ?? schema.required ?? []
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      return { ok: false, error: `缺少必填参数 ${key}` }
    }
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const val = obj[key]
    if (val === undefined) continue
    const err = validateValue(prop, val, key)
    if (err) return { ok: false, error: err }
  }
  return { ok: true, value: obj }
}

// 序列化为发送给百炼的固定 OpenAI tools 结构（剥离内部 runtimeRequired、sideEffect、formatStart、formatDone 等字段）
export function toOpenAiTools(tools: readonly RegisteredTool[]) {
  return tools.map((tool) => {
    const { runtimeRequired: _ignored, ...parameters } = tool.parameters
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters
      }
    }
  })
}

export async function dispatchTool(
  registry: ReadonlyMap<string, RegisteredTool>,
  name: string,
  rawArgs: string,
  env: ToolEnv,
  state: HarnessState
): Promise<ToolExecutionResult> {
  const tool = registry.get(name)
  if (!tool) {
    return { content: JSON.stringify({ error: `没有 ${name} 这个工具` }) }
  }
  const checked = validateToolArgs(tool.parameters, rawArgs)
  if (!checked.ok) {
    return { content: JSON.stringify({ error: checked.error }) }
  }
  return tool.execute(checked.value, env, state)
}
