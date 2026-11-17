/**
 * 服务端配置的本地副本：人设、端点、模型。
 *
 * 这些配置只在设置页修改，聊天时按会话引用的 id 查找。启动时拉一次，
 * 设置页保存后刷新；不做轮询——配置变更不需要实时。
 */
import { create } from 'zustand'
import { getJson, sendEmpty, sendJson } from './http.js'

export type Persona = {
  id: string
  name: string
  prompt: string
  builtin: number
  position: number
}

export type Endpoint = {
  id: string
  name: string
  origin: string
  dialect: 'deepseek' | 'anthropic' | 'openai'
  capabilities: Record<string, boolean>
  hasKey: boolean
  keyHint: string | null
  /** 内置的 DeepSeek 官方端点；不可删除 */
  builtin: boolean
}

/**
 * 推理档位声明，格式与 DeepSeekRuntime 一致：键是档位名，值是发给上游的
 * API 参数值。off 表示关闭思考，其值为 null。
 */
export type ReasoningEfforts = Record<string, string | null>

/** 档位升级顺序，与上游约定一致 */
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ModelConfig = {
  id: string
  endpointId: string
  name: string
  model: string
  inputTypes: string[]
  maxContext: number
  maxOutput: number
  reasoning: ReasoningEfforts
  isDefault: boolean
  /** 该模型在服务端支持原生联网搜索 */
  nativeSearch: boolean
  /** 关闭后不出现在聊天下拉，也不参与任何自动选择 */
  enabled: boolean
}

/** 内置默认人设的 id，与服务端一致 */
export const DEFAULT_PERSONA_ID = '__default__'

type ConfigState = {
  personas: Persona[]
  endpoints: Endpoint[]
  models: ModelConfig[]
  loaded: boolean
}

export const useConfig = create<ConfigState>(() => ({
  personas: [],
  endpoints: [],
  models: [],
  loaded: false,
}))

export const loadConfig = async (): Promise<void> => {
  const data = await getJson<{
    personas: Persona[]
    endpoints: Endpoint[]
    models: ModelConfig[]
  }>('/api/config')
  useConfig.setState({ ...data, loaded: true })
}

/** 配置改动后重新拉取，保持本地副本与服务端一致 */
export const reloadConfig = async (): Promise<void> => {
  await loadConfig().catch(() => {})
}

export const personaById = (id: string | undefined): Persona | undefined =>
  useConfig.getState().personas.find((item) => item.id === (id ?? DEFAULT_PERSONA_ID))

/** 从给定列表里解析模型：优先按 id，其次默认模型，最后第一项 */
export const resolveModelFrom = (
  models: ModelConfig[],
  id: string | null | undefined
): ModelConfig | undefined => {
  if (id) {
    const found = models.find((item) => item.id === id)
    if (found) {
      return found
    }
  }
  return models.find((item) => item.isDefault) ?? models[0]
}

/** 会话未指定模型时用默认模型；读当前 store 快照 */
export const resolveModel = (id: string | null | undefined): ModelConfig | undefined =>
  resolveModelFrom(useConfig.getState().models, id)

export const endpointById = (id: string): Endpoint | undefined =>
  useConfig.getState().endpoints.find((item) => item.id === id)

// ---------- 写入 ----------

export const savePersona = async (persona: {
  id: string
  name: string
  prompt: string
}): Promise<void> => {
  await sendJson('/api/config/personas', 'POST', persona)
  await reloadConfig()
}

export const deletePersona = async (id: string): Promise<void> => {
  await sendEmpty(`/api/config/personas/${encodeURIComponent(id)}`, 'DELETE')
  await reloadConfig()
}

export const saveEndpoint = async (value: {
  id: string
  name: string
  origin: string
  apiKey?: string
  dialect: string
  capabilities?: Record<string, boolean>
}): Promise<void> => {
  await sendJson('/api/config/endpoints', 'POST', value)
  await reloadConfig()
}

export const saveModel = async (value: Partial<ModelConfig> & {
  id: string
  endpointId: string
  model: string
}): Promise<void> => {
  await sendJson('/api/config/models', 'POST', value)
  await reloadConfig()
}

export const deleteEndpoint = async (id: string): Promise<void> => {
  await sendEmpty(`/api/config/endpoints/${encodeURIComponent(id)}`, 'DELETE')
  await reloadConfig()
}

/** 把某个模型设为全局默认 */
export const setDefaultModel = async (id: string): Promise<void> => {
  await sendJson(`/api/config/models/${encodeURIComponent(id)}/set-default`, 'POST')
  await reloadConfig()
}

export const deleteModel = async (id: string): Promise<void> => {
  await sendEmpty(`/api/config/models/${encodeURIComponent(id)}`, 'DELETE')
  await reloadConfig()
}

/** 拉取端点可用模型；draft 允许用编辑器里的未保存值探测 */
export const listEndpointModels = async (
  endpointId: string | null,
  draft?: { origin?: string; apiKey?: string; dialect?: string }
): Promise<{ id: string; name: string | null }[]> => {
  const result = await sendJson<{ models: { id: string; name: string | null }[] }>(
    '/api/config/models/list',
    'POST',
    { endpointId, draft }
  )
  return result.models
}

/** 按模型测试连通性：发一次最小请求确认可用 */
export const testModel = async (modelId: string): Promise<number> => {
  const result = await sendJson<{ latencyMs: number }>('/api/config/test-model', 'POST', {
    modelId,
  })
  return result.latencyMs
}

/** 切换模型启用状态 */
export const setModelEnabled = async (model: ModelConfig, enabled: boolean): Promise<void> => {
  await sendJson('/api/config/models', 'POST', { ...model, enabled })
  await reloadConfig()
}

export const testEndpoint = async (endpointId: string): Promise<void> => {
  await sendJson('/api/config/test-endpoint', 'POST', { endpointId })
}
