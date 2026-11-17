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
import { normalizeEfforts, pickLevel, type ReasoningEfforts } from '../reasoning.ts'
import { formatHits, relaySearch } from '../search.ts'
import { buildUrl } from '../url.ts'

export type EndpointRow = {
  id: string
  name: string
  origin: string
  api_key: string
  dialect: string
  capabilities: string
  /** 1 表示内置 DeepSeek 官方端点 */
  builtin: number
}

export type Capabilities = {
  latestReminder: boolean
  safetyCheck: boolean
  titleExtension: boolean
  thinkingLevel: boolean
  filesApi: boolean
}



const DEFAULT_CAPABILITIES: Capabilities = {
  latestReminder: true,
  safetyCheck: true,
  titleExtension: true,
  thinkingLevel: false,
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
 * 按端点方言生成推理参数。
 *
 * - off 或不发送：不带任何推理字段；
 * - deepseek / anthropic：thinking 开关 + budget_tokens（值可解析为数字时），
 *   否则按 reasoning_effort 透传；
 * - openai：reasoning_effort。
 */
const buildReasoning = (
  efforts: ReasoningEfforts | undefined,
  dialect: string,
  requested?: string | number
): { thinking?: unknown; reasoning_effort?: unknown } => {
  const picked = pickLevel(efforts, requested)
  if (!picked || picked.level === 'off') {
    return {}
  }
  const value = picked.value ?? picked.level
  if (dialect === 'openai') {
    return { reasoning_effort: value }
  }
  // Anthropic / DeepSeek：数值视为 token 预算，否则按强度字符串透传
  const budget = Number(value)
  if (Number.isFinite(budget) && budget > 0 && String(value).trim() !== '') {
    return { thinking: { type: 'enabled', budget_tokens: budget } }
  }
  return { reasoning_effort: value }
}

/**
 * 组装上游请求体。
 *
 * 不支持的字段整块省略，避免陌生端点因未知字段返回 400。
 */
export const buildUpstreamBody = (
  body: ChatRequestBody,
  capabilities: Capabilities,
  dialect: string,
  builtin: boolean,
  efforts?: ReasoningEfforts
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
  // 推理参数分两种来源：
  // - 内置 DeepSeek 端点：完全沿用项目原本的行为，由聊天窗口的「深度思考」开关
  //   决定 thinking.enabled/disabled，与本改造之前一致；
  // - 自定义端点：推理由模型配置的「推理等级」独立决定，不受该开关影响
  //   （界面上该按钮也已被置灰）。
  if (builtin) {
    payload.thinking = body.thinking ?? { type: 'disabled' }
  } else {
    const reasoningFields = buildReasoning(efforts, dialect, body.reasoningLevel)
    if (reasoningFields.thinking !== undefined) {
      payload.thinking = reasoningFields.thinking
    } else if (reasoningFields.reasoning_effort !== undefined) {
      payload.reasoning_effort = reasoningFields.reasoning_effort
    } else {
      // 模型没声明档位即不推理
      payload.thinking = { type: 'disabled' }
    }
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
  // 内置端点与原版一致：不发送 max_tokens，由上游决定输出长度
  if (!builtin && typeof body.max_tokens === 'number') {
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
    reasoning?: ReasoningEfforts
    maxContext?: number
    maxOutput?: number
    nativeSearch?: boolean
  } => {
    // 只考虑启用的模型：关闭的模型不参与任何自动选择
    const selectById = db.prepare(`select * from models where id = ? and enabled = 1`)
    const selectByName = db.prepare(
      `select * from models where model = ? and enabled = 1 order by is_default desc limit 1`
    )
    const selectDefault = db.prepare(
      `select * from models where enabled = 1 order by is_default desc, position limit 1`
    )

    const row = (
      modelId
        ? ((selectById.get(modelId) ?? selectByName.get(modelId)) as unknown)
        : (selectDefault.get() ?? undefined)
    ) as
      | {
          endpoint_id: string
          model: string
          reasoning?: string
          max_context?: number
          max_output?: number
          native_search?: number
        }
      | undefined
    if (!row) {
      throw new HttpError(400, 'no enabled model configured')
    }
    let reasoning: ReasoningEfforts | undefined
    if (typeof row.reasoning === 'string') {
      try {
        reasoning = normalizeEfforts(JSON.parse(row.reasoning))
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
      nativeSearch: row.native_search === 1,
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
        nativeSearch,
      } = resolveEndpoint(modelId)
      if (!endpoint.api_key) {
        throw new HttpError(400, `endpoint "${endpoint.name}" has no API key`)
      }

      const capabilities = capabilitiesFor(endpoint)
      const builtin = endpoint.builtin === 1

      /**
       * 内置端点的请求体与原版逐字段一致，不额外注入任何字段。
       *
       * 原版不发送 max_tokens，也不做客户端上下文裁剪——窗口由上游自己判定。
       * 这两项只对自定义端点生效，否则官方端点的行为会与改造前不同。
       */
      if (!builtin) {
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
      }

      // 搜索回落：模型端点自己没有原生搜索能力时，先借用支持搜索的端点查一次，
      // 把结果作为文本注入本轮提问。回答仍由当前模型给出。
      if (body.search && !nativeSearch) {
        const query = body.searchQuery ?? lastUserText(body.messages)
        if (query) {
          const hits = await relaySearch(db, query, req.signal).catch(() => [])
          if (hits.length > 0) {
            body.messages = injectSearchContext(body.messages, formatHits(hits))
          }
        }
      }

      const reasoning = modelConfig
      const upstreamBody = buildUpstreamBody(body, capabilities, endpoint.dialect, builtin, reasoning)
      // 前端传的 model 是模型 id 或上游模型名；以配置表里的为准
      upstreamBody.model = model
      // 输出上限以模型配置为准；配置未填时保留请求里带来的值
      if (!builtin && maxOutput) {
        upstreamBody.max_tokens = maxOutput
      } else if (builtin) {
        // 内置端点与原版一致：不发送 max_tokens
        delete upstreamBody.max_tokens
      }

      const isOpenAI = endpoint.dialect === 'openai'
      const target = isOpenAI
        ? buildUrl(endpoint.origin, 'openai', 'chat/completions')
        : buildUrl(endpoint.origin, endpoint.dialect, 'messages')

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
      const form = await req.formData()

      const upstream = await fetch(buildUrl(endpoint.origin, endpoint.dialect, 'files'), {
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
      const target = buildUrl(endpoint.origin, endpoint.dialect, 'models')
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

    /**
     * 按模型测试连通性：发一次最小的真实请求，确认这个模型能出结果。
     *
     * 端点级测试只验证密钥与地址，说明不了某个模型是否可用——同一端点上
     * 不同模型的名字、权限、能力都可能不同。这里用最短的 messages 请求
     * （1 token 输出、无工具、无思考），读到响应即视为可用。
     */
    testModel: async (modelId: string): Promise<{ ok: true; latencyMs: number }> => {
      const { endpoint, model } = resolveEndpoint(modelId)
      if (!endpoint.api_key) {
        throw new HttpError(400, `endpoint "${endpoint.name}" has no API key`)
      }
      const isOpenAI = endpoint.dialect === 'openai'
      const target = isOpenAI
        ? buildUrl(endpoint.origin, 'openai', 'chat/completions')
        : buildUrl(endpoint.origin, endpoint.dialect, 'messages')

      const started = Date.now()
      const response = await fetch(target, {
        method: 'POST',
        headers: isOpenAI
          ? { 'content-type': 'application/json', authorization: `Bearer ${endpoint.api_key}` }
          : {
              'content-type': 'application/json',
              'x-api-key': endpoint.api_key,
              authorization: `Bearer ${endpoint.api_key}`,
            },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
          ...(isOpenAI ? { stream: false } : { stream: true }),
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch((error: unknown) => {
        throw new HttpError(502, `request failed: ${String(error)}`)
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new HttpError(response.status, detail || response.statusText)
      }
      // 响应头已到即可确认可用，不必读完整个流
      await response.body?.cancel().catch(() => {})
      return { ok: true, latencyMs: Date.now() - started }
    },

    /**
     * 拉取端点可用的模型列表，供设置页「获取可用模型」使用。
     *
     * OpenAI 与 DeepSeek 返回 `{ data: [{ id }] }`，Anthropic 的条目可能带
     * `display_name`。允许传入编辑器里尚未保存的 origin / key，这样新建端点
     * 填完就能直接拉取，不必先保存。
     */
    listModels: async (
      endpointId: string | null,
      draft?: { origin?: string; apiKey?: string; dialect?: string }
    ): Promise<{ models: { id: string; name: string | null }[] }> => {
      const saved = endpointId ? findEndpoint(endpointId) : undefined
      const origin = (draft?.origin ?? saved?.origin ?? '').replace(/\/+$/, '')
      const apiKey = draft?.apiKey ?? saved?.api_key ?? ''
      const dialect = draft?.dialect ?? saved?.dialect ?? 'deepseek'
      if (!origin) {
        throw new HttpError(400, 'endpoint URL is required')
      }
      if (!apiKey) {
        throw new HttpError(400, 'API key is empty')
      }
      const target = buildUrl(origin, dialect, 'models')
      const response = await fetch(target, {
        headers: { authorization: `Bearer ${apiKey}` },
      }).catch((error: unknown) => {
        throw new HttpError(502, `request failed: ${String(error)}`)
      })
      if (!response.ok) {
        throw new HttpError(response.status, await response.text().catch(() => response.statusText))
      }
      const payload = (await response.json().catch(() => null)) as unknown
      const list =
        typeof payload === 'object' &&
        payload !== null &&
        Array.isArray((payload as { data?: unknown }).data)
          ? ((payload as { data: unknown[] }).data as Record<string, unknown>[])
          : []
      const models = list
        .map((item) => {
          const id = typeof item.id === 'string' ? item.id : null
          const name =
            typeof item.display_name === 'string'
              ? item.display_name
              : typeof item.name === 'string'
                ? item.name
                : null
          return id ? { id, name } : null
        })
        .filter((item): item is { id: string; name: string | null } => item !== null)
      return { models }
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
