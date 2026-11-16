/**
 * 搜索服务。
 *
 * 两种模式：
 * - native：模型端点自己支持服务端搜索工具（Anthropic 的 web_search 或
 *   DeepSeek 的 deepseek_web_search），请求里声明工具即可，服务端会把结果
 *   作为 tool 块流回来；
 * - relay：模型端点不支持时，先向支持搜索的端点借用一次搜索，把结果以文本
 *   形式注入上下文，回答仍由原模型给出。
 *
 * 之所以不做「整条请求改发搜索端点」：那会让用户以为在用自定义模型，实际答案
 * 由另一个模型产出，而且附件的 file_id 跨端点无效。
 */
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from './http.ts'

export type SearchHit = {
  title: string
  url: string
  snippet: string | null
}

/** 借用搜索时最多带回多少条结果，避免把上下文塞满 */
const MAX_HITS = 8

type EndpointRow = {
  id: string
  name: string
  origin: string
  api_key: string
  dialect: string
}

const parseCapabilities = (raw: string): Record<string, boolean> => {
  try {
    return JSON.parse(raw) as Record<string, boolean>
  } catch {
    return {}
  }
}

/** 找到一个支持原生搜索的端点，优先 deepseek 方言（其搜索结果带明文摘要） */
const findSearchEndpoint = (db: DatabaseSync): EndpointRow | undefined => {
  const rows = db.prepare(`select * from endpoints`).all() as EndpointRow[]
  return rows.find((row) => parseCapabilities((row as unknown as { capabilities: string }).capabilities ?? '{}').nativeWebSearch)
}

/**
 * 借用一个端点做一次搜索。
 *
 * 用最小的 messages 请求：只声明搜索工具，让上游返回搜索结果块。
 * 只解析 web_search_tool_result，其他块忽略。
 */
export const relaySearch = async (
  db: DatabaseSync,
  query: string,
  signal?: AbortSignal
): Promise<SearchHit[]> => {
  const endpoint = findSearchEndpoint(db)
  if (!endpoint) {
    throw new HttpError(400, 'no endpoint with native web search configured')
  }
  const base = endpoint.origin.replace(/\/+$/, '')
  const isDeepSeek = endpoint.dialect === 'deepseek'

  const tools = isDeepSeek
    ? [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }]
    : [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]

  const response = await fetch(`${base}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': endpoint.api_key,
      authorization: `Bearer ${endpoint.api_key}`,
    },
    body: JSON.stringify({
      model: isDeepSeek ? 'deepseek-flash' : undefined,
      max_tokens: 1024,
      messages: [{ role: 'user', content: `搜索：${query}` }],
      tools,
      stream: true,
    }),
    signal,
  }).catch((error: unknown) => {
    throw new HttpError(502, `search request failed: ${String(error)}`)
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new HttpError(response.status || 502, detail || 'search failed')
  }

  return collectHits(response.body)
}

/** 从 SSE 里收集搜索结果块中的明文条目 */
const collectHits = async (stream: ReadableStream<Uint8Array>): Promise<SearchHit[]> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const hits: SearchHit[] = []
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue
        }
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') {
          continue
        }
        let event: unknown
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        collectFromEvent(event, hits)
        if (hits.length >= MAX_HITS) {
          void reader.cancel().catch(() => {})
          return hits.slice(0, MAX_HITS)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return hits.slice(0, MAX_HITS)
}

const collectFromEvent = (event: unknown, hits: SearchHit[]): void => {
  if (typeof event !== 'object' || event === null) {
    return
  }
  const block = (event as { content_block?: unknown }).content_block
  if (typeof block !== 'object' || block === null) {
    return
  }
  const value = block as Record<string, unknown>
  if (value.type !== 'web_search_tool_result' || !Array.isArray(value.content)) {
    return
  }
  for (const item of value.content) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const hit = item as Record<string, unknown>
    if (hit.type !== 'web_search_result') {
      continue
    }
    if (typeof hit.url !== 'string' || typeof hit.title !== 'string') {
      continue
    }
    hits.push({
      title: hit.title,
      url: hit.url,
      snippet: typeof hit.snippet === 'string' ? hit.snippet : null,
    })
  }
}

/** 把搜索结果拼成注入用的文本块 */
export const formatHits = (hits: SearchHit[]): string => {
  if (hits.length === 0) {
    return '（联网搜索没有返回结果）'
  }
  const lines = hits.map(
    (hit, index) =>
      `[${index + 1}] ${hit.title}\n${hit.url}${hit.snippet ? `\n${hit.snippet}` : ''}`
  )
  return `以下是联网搜索结果，回答时可引用：\n\n${lines.join('\n\n')}`
}
