/**
 * LLM 代理：浏览器只和本服务通信，由服务端转发到上游。
 *
 * 收益不只是绕开 CORS：API Key 不再进入前端产物，陌生端点的私有字段
 * 也可以在服务端裁剪。响应始终以 Anthropic SSE 形式回吐，前端解析器不用改。
 */
import type { DatabaseSync } from 'node:sqlite'
import { HttpError, readJson } from '../http.ts'
import { toOpenAIBody, translateOpenAIStream } from './openai.ts'
import { trimMessages } from '../context.ts'
import { formatHits, relaySearch } from '../search.ts'

export type EndpointRow = {
  id: string
  name: string
  origin: string
  api_key: string
  dialect: string
  capabilities: string
}

export type Capabilities = {
  latestReminder: boolean
  safetyCheck: boolean
  titleExtension: boolean
  thinkingLevel: boolean
  nativeWebSearch: boolean
  filesApi: boolean
}

/** 模型配置里的推理方式 */
export type ModelReasoning = {
  kind?: 'none' | 'budget' | 'effort'
  levels?: { label: string; value: string | number }[]
  defaultLevel?: string | number
}

const DEFAULT_CAPABILITIES: Capabilities = {
  latestReminder: true,
  safetyCheck: true,
  titleExtension: true,
  thinkingLevel: false,
  nativeWebSearch: false,
  filesApi: true,
}

/** DeepSeek 兼容端点支持全部私有扩展；其余方言按最保守的字段集处理 */
const capabilitiesFor = (row: EndpointRow): Capabilities => {
  let parsed: Partial<Capabilities> = {}
  try {
    parsed = JSON.parse(row.capabilities) as Partial<Capabilities>
  } catch {
    // 配置损坏时退回默认值
  }
  if (row.dialect !== 'deepseek') {
    return {
      latestReminder: false,
      safetyCheck: false,
      titleExtension: false,
      thinkingLevel: false,
      nativeWebSearch: false,
      filesApi: false,
      ...parsed,
    }
  }
  return { ...DEFAULT_CAPABILITIES, ...parsed }
}

/** 请求体的类型约束：只接受已知字段，其余忽略 */
export type ChatRequestBody = {
  model: string
  system?: string
  messages: unknown[]
  thinking?: { type: 'enabled' | 'disabled' }
  /** 推理等级的显式取值；缺省时用模型配置的 defaultLevel */
  reasoningLevel?: string | number
  /** 本轮是否开启联网搜索；端点不支持原生搜索时由服务端借用搜索服务 */
  search?: boolean
  /** 搜索用的查询词；缺省时取最后一条用户消息 */
  searchQuery?: string
  tools?: unknown[]
  safety_check?: { level: string }
  title?: { enabled: boolean }
  max_tokens?: number
}

/** 取最后一条用户消息的纯文本，作为搜索查询词 */
const lastUserText = (messages: unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown>
    if (message.role !== 'user') {
      continue
    }
    const content = message.content
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (block): block is { text: string } =>
            typeof block === 'object' &&
            block !== null &&
            typeof (block as { text?: unknown }).text === 'string'
        )
        .map((block) => block.text)
        .join('\n')
      if (text.trim() !== '') {
        return text
      }
    }
  }
  return ''
}

/**
 * 把搜索结果作为前置文本块注入最后一条用户消息。
 *
 * 不加新消息：多一条 user 会破坏「user/assistant 交替」的假设，
 * 也会让历史轮次统计多出一轮。
 */
const injectSearchContext = (messages: unknown[], text: string): unknown[] => {
  const result = [...messages]
  for (let i = result.length - 1; i >= 0; i--) {
    const message = result[i] as Record<string, unknown>
    if (message.role !== 'user') {
      continue
    }
    const content = message.content
    const prepend = { type: 'text', text: `${text}\n\n---\n\n` }
    result[i] = {
      ...message,
      content:
        typeof content === 'string'
          ? [prepend, { type: 'text', text: content }]
          : [prepend, ...(Array.isArray(content) ? content : [])],
    }
    break
  }
  return result
}

const assertChatBody = (value: unknown): ChatRequestBody => {  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, 'request body must be an object')
  }
  const body = value as Record<string, unknown>
  if (typeof body.model !== 'string' || body.model === '') {
    throw new HttpError(400, 'model is required')
  }
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, 'messages must be an array')
  }
  return body as ChatRequestBody
}

/**
 * 按端点能力裁剪请求体。
 * 不支持的字段整块省略，避免陌生端点因未知字段返回 400。
 */
/**
 * 按模型配置生成推理参数。
 *
 * 三种约定：
 * - budget：Anthropic 风格，thinking.budget_tokens；
 * - effort：OpenAI 风格，reasoning_effort；
 * - none：不发任何推理字段。
 *
 * 等级值来自模型配置；请求未指定时用 defaultLevel。
 */
const buildReasoning = (
  reasoning: { kind?: string; defaultLevel?: string | number } | undefined,
  level: string | number | undefined
): { thinking?: unknown; reasoning_effort?: unknown } => {
  if (!reasoning || reasoning.kind === 'none' || reasoning.kind === undefined) {
    return {}
  }
  const value = level ?? reasoning.defaultLevel
  if (value === undefined) {
    return {}
  }
  if (reasoning.kind === 'budget') {
    const budget = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(budget) && budget > 0
      ? { thinking: { type: 'enabled', budget_tokens: budget } }
      : {}
  }
  if (reasoning.kind === 'effort') {
    return { reasoning_effort: value }
  }
  return {}
}

/**
 * 组装上游请求体。
 *
 * 不支持的字段整块省略，避免陌生端点因未知字段返回 400。
 */
export const buildUpstreamBody = (
  body: ChatRequestBody,
  capabilities: Capabilities,
  reasoning?: { kind?: string; defaultLevel?: string | number }
): Record<string, unknown> => {
  const messages = capabilities.latestReminder
    ? body.messages
    : (body.messages as Record<string, unknown>[]).filter(
        (message) => message.role !== 'latest_reminder'
      )

  const payload: Record<string, unknown> = { model: body.model, messages }

  if (typeof body.system === 'string' && body.system !== '') {
    payload.system = body.system
  }
  // 模型配置声明的推理方式优先；没有配置时沿用前端的开关
  const reasoningFields = buildReasoning(reasoning, body.reasoningLevel)
  if (reasoningFields.thinking !== undefined) {
    payload.thinking = reasoningFields.thinking
  } else if (body.thinking) {
    payload.thinking = body.thinking
  }
  if (reasoningFields.reasoning_effort !== undefined) {
    payload.reasoning_effort = reasoningFields.reasoning_effort
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools
  }
  if (body.safety_check && capabilities.safetyCheck) {
    payload.safety_check = body.safety_check
  }
  if (body.title && capabilities.titleExtension) {
    payload.title = body.title
  }
  if (typeof body.max_tokens === 'number') {
    payload.max_tokens = body.max_tokens
  }
  return payload
}

export const chatRoutes = ({ db }: { db: DatabaseSync }) => {
  const findEndpoint = (id: string): EndpointRow => {
    const row = db.prepare(`select * from endpoints where id = ?`).get(id) as
      | EndpointRow
      | undefined
    if (!row) {
      throw new HttpError(404, 'endpoint not found')
    }
    return row
  }

  /**
   * 找到模型配置；未指定时取默认模型。
   *
   * 入参同时接受配置表主键和上游模型名：前端历史消息里存的是模型名
   * （如 deepseek-flash），会话首次生成时还没有配置主键可传。
   */
  const resolveEndpoint = (
    modelId: string | undefined
  ): {
    endpoint: EndpointRow
    model: string
    reasoning?: ModelReasoning
    maxContext?: number
    maxOutput?: number
  } => {
    const selectById = db.prepare(`select * from models where id = ?`)
    const selectByName = db.prepare(`select * from models where model = ? order by is_default desc limit 1`)
    const selectDefault = db.prepare(`select * from models order by is_default desc, position limit 1`)

    const row = (
      modelId
        ? ((selectById.get(modelId) ?? selectByName.get(modelId)) as unknown)
        : (selectDefault.get() ?? undefined)
    ) as
      | { endpoint_id: string; model: string; reasoning?: string; max_context?: number; max_output?: number }
      | undefined
    if (!row) {
      throw new HttpError(400, 'no model configured')
    }
    let reasoning: ModelReasoning | undefined
    if (typeof row.reasoning === 'string') {
      try {
        reasoning = JSON.parse(row.reasoning) as ModelReasoning
      } catch {
        // 配置损坏时按不支持推理处理
      }
    }
    return {
      endpoint: findEndpoint(row.endpoint_id),
      model: row.model,
      reasoning,
      maxContext: typeof row.max_context === 'number' ? row.max_context : undefined,
      maxOutput: typeof row.max_output === 'number' ? row.max_output : undefined,
    }
  }

  return {
    /** POST /api/chat：转发并原样回吐 SSE */
    proxy: async (req: Request, modelId: string | undefined): Promise<Response> => {
      const body = assertChatBody(await readJson(req))
      const {
        endpoint,
        model,
        reasoning: modelConfig,
        maxContext,
        maxOutput,
      } = resolveEndpoint(modelId)
      if (!endpoint.api_key) {
        throw new HttpError(400, `endpoint "${endpoint.name}" has no API key`)
      }

      const capabilities = capabilitiesFor(endpoint)

      // 按模型窗口裁剪历史；输出预算从窗口里预留，避免请求本身超限
      const outputBudget = body.max_tokens ?? maxOutput ?? 0
      if (maxContext && maxContext > 0) {
        const trimmed = trimMessages(
          body.messages as { role: string; content?: unknown }[],
          maxContext,
          outputBudget
        )
        body.messages = trimmed.messages
      }

      // 搜索回落：模型端点自己没有原生搜索能力时，先借用支持搜索的端点查一次，
      // 把结果作为文本注入本轮提问。回答仍由当前模型给出。
      if (body.search && !capabilities.nativeWebSearch) {
        const query = body.searchQuery ?? lastUserText(body.messages)
        if (query) {
          const hits = await relaySearch(db, query, req.signal).catch(() => [])
          if (hits.length > 0) {
            body.messages = injectSearchContext(body.messages, formatHits(hits))
          }
        }
      }

      const reasoning = modelConfig
      const upstreamBody = buildUpstreamBody(body, capabilities, reasoning)
      // 前端传的 model 是模型 id 或上游模型名；以配置表里的为准
      upstreamBody.model = model
      // 输出上限：请求没指定时用模型配置值
      if (typeof upstreamBody.max_tokens !== 'number' && maxOutput) {
        upstreamBody.max_tokens = maxOutput
      }

      const base = endpoint.origin.replace(/\/+$/, '')
      const isOpenAI = endpoint.dialect === 'openai'
      const target = isOpenAI
        ? `${base}/v1/chat/completions`
        : `${base}/anthropic/v1/messages`

      const headers: Record<string, string> = isOpenAI
        ? {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${endpoint.api_key}`,
          }
        : {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-api-key': endpoint.api_key,
            authorization: `Bearer ${endpoint.api_key}`,
          }
      if (capabilities.filesApi) {
        headers['anthropic-beta'] = 'files-api-2025-04-14'
      }

      const requestBody = isOpenAI
        ? toOpenAIBody(body, upstreamBody)
        : { ...upstreamBody, stream: true }

      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: req.signal,
      }).catch((error: unknown) => {
        throw new HttpError(502, `upstream request failed: ${String(error)}`)
      })

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '')
        throw new HttpError(upstream.status, detail || upstream.statusText, detail)
      }

      const contentType = upstream.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const text = await upstream.text().catch(() => '')
        throw new HttpError(502, `upstream did not return SSE: ${text.slice(0, 200)}`)
      }

      // OpenAI 方言的 SSE 结构完全不同，翻译成 Anthropic 事件后再回吐，
      // 前端的解析器与 UI 因此不需要知道上游是谁。
      const stream = isOpenAI
        ? translateOpenAIStream(upstream.body as ReadableStream<Uint8Array>, model)
        : upstream.body

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // 明确告知前置代理不要缓冲（NPM 仍需要 proxy_buffering off）
          'x-accel-buffering': 'no',
        },
      })
    },

    /** POST /api/files：把附件转发到上游 Files API，返回 file_id */
    upload: async (
      req: Request,
      modelId: string | undefined
    ): Promise<{ id: string }> => {
      const { endpoint } = resolveEndpoint(modelId)
      if (!capabilitiesFor(endpoint).filesApi) {
        throw new HttpError(501, 'this endpoint does not support the Files API')
      }
      const base = endpoint.origin.replace(/\/+$/, '')
      const form = await req.formData()

      const upstream = await fetch(`${base}/anthropic/v1/files`, {
        method: 'POST',
        headers: {
          'x-api-key': endpoint.api_key,
          'anthropic-beta': 'files-api-2025-04-14',
        },
        body: form,
      }).catch((error: unknown) => {
        throw new HttpError(502, `upload failed: ${String(error)}`)
      })

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '')
        throw new HttpError(upstream.status, detail || upstream.statusText, detail)
      }
      const result = (await upstream.json()) as { id?: string }
      if (typeof result.id !== 'string') {
        throw new HttpError(502, 'upstream did not return a file id')
      }
      return { id: result.id }
    },

    /** 供设置页「测试连接」用：GET /models 不产生费用 */
    verify: async (endpointId: string): Promise<{ ok: true; models: unknown }> => {
      const endpoint = findEndpoint(endpointId)
      if (!endpoint.api_key) {
        throw new HttpError(400, 'API key is empty')
      }
      const base = endpoint.origin.replace(/\/+$/, '')
      const target =
        endpoint.dialect === 'openai' ? `${base}/v1/models` : `${base}/models`
      const response = await fetch(target, {
        headers: { authorization: `Bearer ${endpoint.api_key}` },
      }).catch((error: unknown) => {
        throw new HttpError(502, `request failed: ${String(error)}`)
      })
      if (!response.ok) {
        throw new HttpError(response.status, await response.text().catch(() => response.statusText))
      }
      return { ok: true, models: await response.json().catch(() => null) }
    },

    /** 语音识别：DeepSeek 私有工具接口 */
    transcribe: async (req: Request): Promise<{ text: string }> => {
      const endpoint = voiceEndpoint()
      const base = endpoint.origin.replace(/\/+$/, '')
      const form = await req.formData()
      const upstream = await fetch(`${base}/v1/tools/asr`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.api_key}` },
        body: form,
      }).catch((error: unknown) => {
        throw new HttpError(502, `asr failed: ${String(error)}`)
      })
      if (!upstream.ok) {
        throw new HttpError(upstream.status, await upstream.text().catch(() => upstream.statusText))
      }
      const body = (await upstream.json()) as { text?: unknown }
      if (typeof body.text !== 'string') {
        throw new HttpError(502, 'asr did not return text')
      }
      return { text: body.text }
    },

    /** 语音合成：返回裸 PCM 流 */
    synthesize: async (req: Request): Promise<Response> => {
      const endpoint = voiceEndpoint()
      const base = endpoint.origin.replace(/\/+$/, '')
      const body = await req.text()
      const upstream = await fetch(`${base}/v1/tools/tts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${endpoint.api_key}`,
          'content-type': 'application/json',
        },
        body,
        signal: req.signal,
      }).catch((error: unknown) => {
        throw new HttpError(502, `tts failed: ${String(error)}`)
      })
      if (!upstream.ok) {
        throw new HttpError(upstream.status, await upstream.text().catch(() => upstream.statusText))
      }
      return new Response(upstream.body, {
        headers: {
          'content-type': upstream.headers.get('content-type') ?? 'audio/L16',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        },
      })
    },
  }

  /** 语音只有 DeepSeek 官方端点提供，取第一个 deepseek 方言的端点 */
  function voiceEndpoint(): EndpointRow {
    const row = db.prepare(`select * from endpoints where dialect = 'deepseek' limit 1`).get() as
      | EndpointRow
      | undefined
    if (!row) {
      throw new HttpError(400, 'no deepseek endpoint configured')
    }
    return row
  }
}

export type ChatRoutes = ReturnType<typeof chatRoutes>
