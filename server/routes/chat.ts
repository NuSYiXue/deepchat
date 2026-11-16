/**
 * LLM 代理：浏览器只和本服务通信，由服务端转发到上游。
 *
 * 收益不只是绕开 CORS：API Key 不再进入前端产物，陌生端点的私有字段
 * 也可以在服务端裁剪。响应始终以 Anthropic SSE 形式回吐，前端解析器不用改。
 */
import type { DatabaseSync } from 'node:sqlite'
import { HttpError, readJson } from '../http.ts'

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
  tools?: unknown[]
  safety_check?: { level: string }
  title?: { enabled: boolean }
  max_tokens?: number
}

const assertChatBody = (value: unknown): ChatRequestBody => {
  if (typeof value !== 'object' || value === null) {
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
export const buildUpstreamBody = (
  body: ChatRequestBody,
  capabilities: Capabilities,
  dialect: string
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    model: body.model,
    messages: capabilities.latestReminder
      ? body.messages
      : (body.messages as Record<string, unknown>[]).filter(
          (message) => message.role !== 'latest_reminder'
        ),
  }

  if (typeof body.system === 'string' && body.system !== '') {
    payload.system = body.system
  }
  if (body.thinking) {
    payload.thinking = body.thinking
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

  // OpenAI 方言的 system 走 messages 首条，这里是占位，P7 再接翻译层
  if (dialect === 'openai') {
    throw new HttpError(501, `dialect "${dialect}" is not implemented yet`)
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
  const resolveEndpoint = (modelId: string | undefined): { endpoint: EndpointRow; model: string } => {
    const selectById = db.prepare(`select * from models where id = ?`)
    const selectByName = db.prepare(`select * from models where model = ? order by is_default desc limit 1`)
    const selectDefault = db.prepare(`select * from models order by is_default desc, position limit 1`)

    const row = (
      modelId
        ? ((selectById.get(modelId) ?? selectByName.get(modelId)) as unknown)
        : (selectDefault.get() ?? undefined)
    ) as { endpoint_id: string; model: string } | undefined
    if (!row) {
      throw new HttpError(400, 'no model configured')
    }
    return { endpoint: findEndpoint(row.endpoint_id), model: row.model }
  }

  return {
    /** POST /api/chat：转发并原样回吐 SSE */
    proxy: async (req: Request, modelId: string | undefined): Promise<Response> => {
      const body = assertChatBody(await readJson(req))
      const { endpoint, model } = resolveEndpoint(modelId)
      if (!endpoint.api_key) {
        throw new HttpError(400, `endpoint "${endpoint.name}" has no API key`)
      }

      const capabilities = capabilitiesFor(endpoint)
      const upstreamBody = buildUpstreamBody(body, capabilities, endpoint.dialect)
      // 前端传的 model 是模型 id 或上游模型名；以配置表里的为准
      upstreamBody.model = model

      const base = endpoint.origin.replace(/\/+$/, '')
      const target =
        endpoint.dialect === 'deepseek' || endpoint.dialect === 'anthropic'
          ? `${base}/anthropic/v1/messages`
          : `${base}/v1/chat/completions`

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': endpoint.api_key,
        authorization: `Bearer ${endpoint.api_key}`,
      }
      if (capabilities.filesApi) {
        headers['anthropic-beta'] = 'files-api-2025-04-14'
      }

      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...upstreamBody, stream: true }),
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

      return new Response(upstream.body, {
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
