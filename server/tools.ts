/**
 * 服务端工具调用循环。
 *
 * 自定义端点不支持「服务端内置搜索」时，由我们自己把搜索包装成一个工具声明
 * 给模型，模型自主决定要不要调用——这样「你好」这类寒暄不会触发搜索，只有
 * 真的需要外部信息时才会搜。相比"开关一开就无条件搜一遍"，行为与原生搜索一致。
 *
 * 循环流程：
 *   1. 请求时声明 search_web 工具；
 *   2. 上游返回 tool_use 时，取出 query 执行真实的搜索 API；
 *   3. 把结果作为 tool_result 追加进 messages，再请求一次；
 *   4. 最多 MAX_ROUNDS 轮。
 *
 * 对前端补发一对 server_tool_use + web_search_tool_result 块，这样「已阅读
 * N 个网页」的来源卡片在兜底模式下也能显示。
 */
import type { SearchHit } from './search.ts'

/** 单次回复里最多允许几轮工具调用，防止模型反复搜索 */
export const MAX_ROUNDS = 5

/** 声明给模型的工具名 */
export const TOOL_NAME = 'search_web'

/** 读取网页正文的工具名 */
export const READ_TOOL_NAME = 'read_url'

const DESCRIPTION =
  '搜索互联网获取实时信息。仅当问题涉及近期事件、具体数据、天气、价格、' +
  '人物近况等你无法确定的事实时才使用。寒暄、闲聊、常识问题、代码问题不要使用。'

const READ_DESCRIPTION =
  '读取指定网页的正文。通常在搜索结果里看到可能有用的链接后，用它打开细看。' +
  '不要凭猜测调用，url 必须来自搜索结果或用户提供。'

/** Anthropic 方言的工具声明 */
export const anthropicSearchTool = () => ({
  name: TOOL_NAME,
  description: DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索关键词，保持简短' } },
    required: ['query'],
  },
})

/** Anthropic 方言的网页读取工具声明 */
export const anthropicReadTool = () => ({
  name: READ_TOOL_NAME,
  description: READ_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string', description: '要读取的网页地址' } },
    required: ['url'],
  },
})

/** OpenAI 方言的工具声明 */
export const openAISearchTool = () => ({
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词，保持简短' } },
      required: ['query'],
    },
  },
})

/** OpenAI 方言的网页读取工具声明 */
export const openAIReadTool = () => ({
  type: 'function',
  function: {
    name: READ_TOOL_NAME,
    description: READ_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要读取的网页地址' } },
      required: ['url'],
    },
  },
})

type AnyRecord = Record<string, unknown>

/** 解析出的工具调用：工具名 + 参数 */
export type ToolCall = { name: string; args: Record<string, unknown> }

/** 从 Anthropic 的 tool_use 块里取工具调用 */
export const toolCallFromAnthropic = (block: AnyRecord): ToolCall | null => {
  if (block.type !== 'tool_use') {
    return null
  }
  if (block.name !== TOOL_NAME && block.name !== READ_TOOL_NAME) {
    return null
  }
  const input = block.input
  if (typeof input !== 'object' || input === null) {
    return null
  }
  return { name: block.name as string, args: input as Record<string, unknown> }
}

/** 从 OpenAI 的 tool_call 里取工具调用（arguments 是 JSON 字符串） */
export const toolCallFromOpenAI = (call: AnyRecord): ToolCall | null => {
  const fn = call.function as AnyRecord | undefined
  if (!fn || typeof fn.name !== 'string') {
    return null
  }
  if (fn.name !== TOOL_NAME && fn.name !== READ_TOOL_NAME) {
    return null
  }
  const args = fn.arguments
  if (typeof args !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    return { name: fn.name, args: parsed }
  } catch {
    return null
  }
}

/** 从工具调用里取搜索关键词 */
export const searchQueryOf = (call: ToolCall): string | null => {
  const query = call.args.query
  return typeof query === 'string' && query.trim() !== '' ? query.trim() : null
}

/** 从工具调用里取要读取的网址 */
export const readUrlOf = (call: ToolCall): string | null => {
  const url = call.args.url
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : null
}

/** 把 Anthropic 的 tool_result 内容块拼好 */
export const anthropicToolResult = (toolUseId: string, text: string): AnyRecord => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content: text,
})

/** 把 OpenAI 的 tool 消息拼好 */
export const openAIToolMessage = (callId: string, text: string): AnyRecord => ({
  role: 'tool',
  tool_call_id: callId,
  content: text,
})

/**
 * 搜索结果转成给模型看的文本。
 *
 * 优先给正文（DeepSeek 的 need_content）：只有 snippet 时模型常常觉得信息
 * 不足，反复搜三四轮把工具预算耗光。带上正文后一次就能拿到足够信息。
 */
export const formatHitsForTool = (hits: SearchHit[]): string => {
  if (hits.length === 0) {
    return '搜索没有返回结果。'
  }
  return hits
    .map((hit, index) => {
      const head = `[${index + 1}] ${hit.title}\n${hit.url}`
      const body = hit.content ?? hit.snippet
      return body ? `${head}\n${body}` : head
    })
    .join('\n\n')
}

/**
 * 把一次搜索的结果伪装成 Anthropic 的 server_tool_use + web_search_tool_result，
 * 让前端的来源卡片能正常渲染。
 *
 * 前端只认这两个块（见 parseEvent.ts / view.ts）；标准格式没有 kind 字段，
 * 这里显式补上 'search'，与之前对真实上游响应的归一化保持一致。
 */
export const searchBlocksAsSSE = (
  toolUseId: string,
  toolUseQuery: string,
  hits: SearchHit[],
  startIndex: number
): string => {
  const events: string[] = []
  const push = (event: string, data: unknown) => {
    events.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  push('content_block_start', {
    type: 'content_block_start',
    index: startIndex,
    content_block: {
      type: 'server_tool_use',
      id: toolUseId,
      // 必须用 DeepSeek 的私有工具名：前端 parseEvent 只认这两个名字
      // 配 kind + input.action 的组合，用标准的 'web_search' 会被丢弃。
      name: 'deepseek_web_search',
      input: { action: 'search', queries: [toolUseQuery] },
      kind: 'search',
      caller: { type: 'direct' },
    },
  })
  push('content_block_stop', { type: 'content_block_stop', index: startIndex })

  push('content_block_start', {
    type: 'content_block_start',
    index: startIndex + 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      kind: 'search',
      content: hits.map((hit) => ({
        type: 'web_search_result',
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        site_name: null,
        site_icon: null,
        page_age: null,
      })),
    },
  })
  push('content_block_stop', { type: 'content_block_stop', index: startIndex + 1 })

  return events.join('')
}

/**
 * 把一次网页读取伪装成 Anthropic 的 server_tool_use + web_fetch_tool_result。
 *
 * 与搜索同理：前端靠这两个块显示「打开了哪个网页」。kind 用 'read_link'，
 * 与 DeepSeek 的 read_url 语义一致（见 view.ts 的 isReadLinkKind）。
 */
export const fetchBlocksAsSSE = (
  toolUseId: string,
  url: string,
  page: { title: string; content: string },
  startIndex: number
): string => {
  const events: string[] = []
  const push = (event: string, data: unknown) => {
    events.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  push('content_block_start', {
    type: 'content_block_start',
    index: startIndex,
    content_block: {
      type: 'server_tool_use',
      id: toolUseId,
      name: 'deepseek_read_url',
      input: { action: 'read_link', url },
      kind: 'read_link',
      caller: { type: 'direct' },
    },
  })
  push('content_block_stop', { type: 'content_block_stop', index: startIndex })

  push('content_block_start', {
    type: 'content_block_start',
    index: startIndex + 1,
    content_block: {
      type: 'web_fetch_tool_result',
      tool_use_id: toolUseId,
      kind: 'read_link',
      content: {
        type: 'web_fetch_result',
        url,
        title: page.title,
        content: page.content,
        site_name: null,
        site_icon: null,
        page_age: null,
      },
    },
  })
  push('content_block_stop', { type: 'content_block_stop', index: startIndex + 1 })

  return events.join('')
}
