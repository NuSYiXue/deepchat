/**
 * 搜索服务。
 *
 * 两种模式：
 * - native：模型端点自己支持服务端搜索工具（Anthropic 的 web_search 或
 *   DeepSeek 的 deepseek_web_search），请求里声明工具即可，服务端会把结果
 *   作为 tool 块流回来；
 * - relay：模型端点不支持时，用**独立的搜索 API** 查一次，把结果以文本形式
 *   注入上下文，回答仍由原模型给出。
 *
 * 搜索 API 与模型端点解耦：自定义端点配一个搜索服务即可给所有不支持原生搜索
 * 的模型用。内置 DeepSeek 端点不参与——它有自己的原生搜索，也不该替别的模型
 * 消耗配额。
 */
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from './http.ts'

export type SearchHit = {
  title: string
  url: string
  snippet: string | null
  /** 正文摘要（DeepSeek 的 need_content 返回 content/summary）；其他搜索服务可能没有 */
  content?: string | null
}

/** 借用搜索时最多带回多少条结果，避免把上下文塞满 */
const MAX_HITS = 8

/**
 * 单条结果正文最多保留多少字符。
 *
 * 8 条 × 3000 字符 ≈ 24KB，对上下文是合理占用；再多会挤掉历史消息。
 */
const MAX_HIT_CONTENT_CHARS = 3000

/** 搜索服务的配置，存在 settings 表里（键 search.config） */
export type SearchConfig = {
  /** 关闭后不启用兜底搜索 */
  enabled: boolean
  /**
   * 预设格式：
   * - deepseek：DeepSeek 的 /v1/tools/search，字段结构固定；
   * - custom：由下面的 url + 映射表达式决定。
   */
  preset: 'deepseek' | 'custom'
  /** custom 模式下的完整请求地址 */
  url: string
  /** Bearer token；deepseek 模式填 DeepSeek 的 API Key */
  apiKey: string
  /** custom 模式：附加请求头，形如 {"X-Api-Key":"..."} 的 JSON 字符串 */
  headers: string
  /** custom 模式：把结果列表从响应里取出来的表达式，如 results 或 data.items */
  resultsPath: string
  /** custom 模式：结果条目的字段名，留空用常见默认值 */
  titleField: string
  urlField: string
  snippetField: string
  /**
   * 网页正文抓取地址。留空表示不支持读取网页。
   *
   * 自定义端点没有 DeepSeek 的 read_url 工具，所以要自己提供一个：模型调用
   * read_url 工具时，服务端 POST 到这个地址取正文。DeepSeek 用
   * https://api.deepseek.com/v1/tools/fetch，请求 { url }、响应 { title, content }。
   * 与搜索共用同一个 Key。
   */
  fetchUrl: string
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  enabled: false,
  preset: 'deepseek',
  url: 'https://api.deepseek.com/v1/tools/search',
  apiKey: '',
  headers: '',
  resultsPath: 'results',
  titleField: 'title',
  urlField: 'url',
  snippetField: 'snippet',
  fetchUrl: 'https://api.deepseek.com/v1/tools/fetch',
}

/** 从 settings 表读配置；缺字段时用默认值补齐，兼容旧数据 */
export const readSearchConfig = (db: DatabaseSync): SearchConfig => {
  const row = db.prepare(`select value from settings where key = 'search.config'`).get() as
    | { value: string }
    | undefined
  if (!row) {
    return { ...DEFAULT_SEARCH_CONFIG }
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<SearchConfig>
    return { ...DEFAULT_SEARCH_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_SEARCH_CONFIG }
  }
}

export const writeSearchConfig = (db: DatabaseSync, config: SearchConfig): void => {
  db.prepare(
    `insert into settings (key, value) values ('search.config', ?)
     on conflict(key) do update set value = excluded.value`
  ).run(JSON.stringify(config))
}

/** 搜索服务是否可用：开了且填了地址与 Key */
export const isSearchConfigured = (config: SearchConfig): boolean =>
  config.enabled && config.url.trim() !== '' && config.apiKey.trim() !== ''

/** 按 a.b.c 取值；数组下标也支持，如 data.items.0.title */
const pick = (value: unknown, path: string): unknown => {
  if (path.trim() === '') {
    return value
  }
  let current: unknown = value
  for (const key of path.split('.')) {
    if (current === null || current === undefined) {
      return undefined
    }
    if (Array.isArray(current)) {
      const index = Number(key)
      current = Number.isInteger(index) ? current[index] : undefined
      continue
    }
    if (typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** 把任意值转成可展示的字符串；对象类型直接丢弃，避免把整段 JSON 塞进上下文 */
const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

/**
 * 按配置查一次搜索。
 *
 * 失败一律抛 HttpError，由调用方决定是否吞掉——兜底搜索失败不该让主对话报错，
 * 但设置页的「测试搜索」需要看到原因。
 */
export const runSearch = async (
  config: SearchConfig,
  query: string,
  signal?: AbortSignal
): Promise<SearchHit[]> => {
  if (!isSearchConfigured(config)) {
    throw new HttpError(400, 'search service is not configured')
  }

  const isPreset = config.preset === 'deepseek'
  /**
   * DeepSeek 预设带上 need_content：直接返回正文摘要，模型一次就能拿到足够
   * 信息，不必反复搜索——实测模型因为只有 snippet 而连搜三四轮，很快耗尽
   * 工具轮次。自定义模式不下发未知字段，避免被服务端拒绝。
   */
  const body = isPreset
    ? { query, count: MAX_HITS, need_content: true }
    : { query }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  }
  if (!isPreset && config.headers.trim() !== '') {
    try {
      const extra = JSON.parse(config.headers) as Record<string, unknown>
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string') {
          headers[key] = value
        }
      }
    } catch {
      throw new HttpError(400, 'custom headers must be valid JSON')
    }
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }).catch((error: unknown) => {
    throw new HttpError(502, `search request failed: ${String(error)}`)
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new HttpError(response.status, detail || 'search failed')
  }

  const payload = (await response.json().catch(() => null)) as unknown
  if (payload === null) {
    throw new HttpError(502, 'search service returned invalid JSON')
  }

  const list = isPreset ? pick(payload, 'results') : pick(payload, config.resultsPath)
  if (!Array.isArray(list)) {
    throw new HttpError(
      502,
      isPreset
        ? 'search response has no results array'
        : `search response has no array at "${config.resultsPath}"`
    )
  }

  const titleField = isPreset ? 'title' : config.titleField || 'title'
  const urlField = isPreset ? 'url' : config.urlField || 'url'
  const snippetField = isPreset ? 'snippet' : config.snippetField || 'snippet'

  const hits: SearchHit[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as Record<string, unknown>
    const title = asText(pick(record, titleField))
    const url = asText(pick(record, urlField))
    if (!title || !url) {
      continue
    }
    /** 正文优先用 content，没有就退回 summary；两者都可能缺失 */
    const content =
      asText(pick(record, 'content')) ?? asText(pick(record, 'summary')) ?? null
    hits.push({
      title,
      url,
      snippet: asText(pick(record, snippetField)),
      content: content ? content.slice(0, MAX_HIT_CONTENT_CHARS) : null,
    })
    if (hits.length >= MAX_HITS) {
      break
    }
  }
  return hits
}

/**
 * 抓取网页正文。
 *
 * 自定义端点没有 DeepSeek 的 read_url 工具，由服务端代劳：模型调用 read_url
 * 工具时走这里。请求体固定为 { url }，响应取 title / content（DeepSeek 的
 * /v1/tools/fetch 就是这个形状）；自定义服务可用 contentPath 指定位置。
 *
 * 失败抛 HttpError，与搜索一样由调用方决定要不要吞掉。
 */
export const runFetch = async (
  config: SearchConfig,
  url: string,
  signal?: AbortSignal
): Promise<{ title: string; content: string }> => {
  if (config.fetchUrl.trim() === '' || config.apiKey.trim() === '') {
    throw new HttpError(400, 'page fetching is not configured')
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError(400, 'url must start with http:// or https://')
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  }
  if (config.preset === 'custom' && config.headers.trim() !== '') {
    try {
      const extra = JSON.parse(config.headers) as Record<string, unknown>
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string') {
          headers[key] = value
        }
      }
    } catch {
      throw new HttpError(400, 'custom headers must be valid JSON')
    }
  }

  const response = await fetch(config.fetchUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
    signal,
  }).catch((error: unknown) => {
    throw new HttpError(502, `fetch request failed: ${String(error)}`)
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new HttpError(response.status, detail || 'fetch failed')
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) {
    throw new HttpError(502, 'fetch service returned invalid JSON')
  }
  const title = typeof payload.title === 'string' ? payload.title : ''
  const content = typeof payload.content === 'string' ? payload.content : ''
  if (content === '') {
    throw new HttpError(502, 'fetch service returned no content')
  }
  // 正文可能很长，截断避免撑爆上下文
  return { title, content: content.slice(0, MAX_FETCH_CHARS) }
}

/** 抓回来的正文最多保留多少字符；超出的部分对回答没有帮助，只会挤占上下文 */
const MAX_FETCH_CHARS = 20000

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
