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
}

export type ReasoningConfig = {
  kind: 'none' | 'budget' | 'effort'
  levels?: { label: string; value: string | number }[]
  defaultLevel?: string | number
}

export type ModelConfig = {
  id: string
  endpointId: string
  name: string
  model: string
  inputTypes: string[]
  maxContext: number
  maxOutput: number
  reasoning: ReasoningConfig
  isDefault: boolean
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

/** 会话未指定模型时用默认模型 */
export const resolveModel = (id: string | null | undefined): ModelConfig | undefined => {
  const { models } = useConfig.getState()
  if (id) {
    const found = models.find((item) => item.id === id)
    if (found) {
      return found
    }
  }
  return models.find((item) => item.isDefault) ?? models[0]
}

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

export const deleteModel = async (id: string): Promise<void> => {
  await sendEmpty(`/api/config/models/${encodeURIComponent(id)}`, 'DELETE')
  await reloadConfig()
}

export const testEndpoint = async (endpointId: string): Promise<void> => {
  await sendJson('/api/config/test-endpoint', 'POST', { endpointId })
}
