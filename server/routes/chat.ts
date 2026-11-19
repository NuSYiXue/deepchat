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
import { isSearchConfigured, readSearchConfig, runFetch, runSearch, type SearchHit } from '../search.ts'
import {
  MAX_ROUNDS,
  READ_TOOL_NAME,
  TOOL_NAME,
  anthropicReadTool,
  anthropicSearchTool,
  anthropicToolResult,
  fetchBlocksAsSSE,
  formatHitsForTool,
  openAIReadTool,
  openAISearchTool,
  openAIToolMessage,
  readUrlOf,
  searchBlocksAsSSE,
  searchQueryOf,
  toolCallFromAnthropic,
  toolCallFromOpenAI,
  type ToolCall,
} from '../tools.ts'
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
  efforts?: ReasoningEfforts,
  nativeSearch?: boolean,
  /** 是否用自定义 search_web 工具（未配置搜索服务时为 false） */
  useSearchTool = false,
  /** 是否声明 read_url 工具（配置了抓取地址时为 true） */
  useFetchTool = false
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
    /**
     * 前端固定声明的是 DeepSeek 私有工具（deepseek_web_search / deepseek_read_url）。
     *
     * 自定义端点不认识这些名字，原样转发会被上游拒掉整条请求——表现就是勾不勾
     * 「原生联网搜索」都提示不支持。这里按方言过滤，两种搜索方式**互斥**：
     * - deepseek 方言（只可能是内置端点）：原样保留，行为与原版一致；
     * - anthropic 方言 + 模型声明原生搜索：换成标准的 web_search，由上游执行；
     * - anthropic 方言 + 无原生搜索：换成我们自己的 search_web 工具，
     *   模型自主调用，服务端执行搜索后回灌结果（见 tools.ts）；
     * - openai 方言：用 function calling 声明 search_web，同上。
     *
     * 不会同时声明两个工具：原生可用时就用原生的，那是最优路径。
     */
    if (dialect === 'deepseek') {
      payload.tools = body.tools
    } else if (dialect === 'anthropic' && nativeSearch === true) {
      // 原生搜索可用：交给上游执行，这是最优路径，不叠加自己的工具
      payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
    } else if (useSearchTool || useFetchTool) {
      /**
       * 自定义端点：声明我们自己的工具。
       *
       * 搜索工具受「智能搜索」开关控制；读取网页（read_url）是独立能力，
       * 只要配了抓取地址就给——用户点开搜索结果里的链接是常见诉求，
       * 与是否开启搜索无关。所以这里的判断是「任一成立」而不是只看搜索。
       */
      const tools: unknown[] = []
      if (useSearchTool && body.search === true) {
        tools.push(dialect === 'openai' ? openAISearchTool() : anthropicSearchTool())
      }
      if (useFetchTool) {
        tools.push(dialect === 'openai' ? openAIReadTool() : anthropicReadTool())
      }
      if (tools.length > 0) {
        payload.tools = tools
      }
    }
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

/**
 * 合成内容块的 index 起点。
 *
 * 取一个远大于真实块数量的值，与上游从 0 开始的编号彻底隔开——前端按 index
 * 建立块映射（reply.ts 的 blockIndexes），撞号会让 delta 写到错误的块上。
 */
const SYNTHETIC_BLOCK_BASE = 10_000

/**
 * 把一段 SSE 里所有内容块的 index 整体偏移。
 *
 * 每一轮上游请求都从 index 0 重新编号，但多轮的块会拼进同一条流交给前端。
 * 前端按 index 建立块映射（reply.ts 的 blockIndexes），重号会让后一个块覆盖
 * 前一个，前一个就成了孤儿——表现为思考块消失、来源卡片错位。
 *
 * 每轮分配一段独立的 index 区间（见 ROUND_INDEX_STRIDE），合成块再用更高位的
 * 区间，两层互不重叠。
 */
const shiftSSEIndexes = (sseText: string, offset: number): string => {
  if (offset === 0) {
    return sseText
  }
  return sseText
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) {
        return line
      }
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') {
        return line
      }
      try {
        const event = JSON.parse(payload) as Record<string, unknown>
        if (typeof event.index === 'number') {
          event.index += offset
          return `data: ${JSON.stringify(event)}`
        }
        return line
      } catch {
        return line
      }
    })
    .join('\n')
}

/**
 * 丢弃 SSE 里所有工具相关的块。
 *
 * 用在最后一轮：此时已不再声明工具，但历史消息里还有之前的工具调用记录，
 * 模型仍可能继续输出 tool_use。这些块对前端没有意义，原样推送会让界面上
 * 出现原始 JSON 片段或被 parseEvent 丢弃后留下空块，所以直接剔掉。
 *
 * 保留 message_start / message_delta / message_stop 等结构事件，否则前端
 * 收不到结束信号。
 */
const stripToolBlocks = (sseText: string): string => {
  const lines = sseText.split('\n')
  const dropIndexes = new Set<number>()
  const parsed: (Record<string, unknown> | null)[] = lines.map((line) => {
    if (!line.startsWith('data:')) {
      return null
    }
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') {
      return null
    }
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      return null
    }
  })

  // 先找出所有 tool_use 块的 index
  for (const event of parsed) {
    if (!event || event.type !== 'content_block_start') {
      continue
    }
    const block = event.content_block as Record<string, unknown> | undefined
    if (block?.type === 'tool_use' && typeof event.index === 'number') {
      dropIndexes.add(event.index)
    }
  }
  if (dropIndexes.size === 0) {
    return sseText
  }

  // 再把属于这些 index 的事件整条丢掉
  return lines
    .filter((_line, position) => {
      const event = parsed[position]
      if (!event) {
        return true
      }
      return !(typeof event.index === 'number' && dropIndexes.has(event.index))
    })
    .join('\n')
}

/** 每轮真实块占用的 index 步长，需大于单轮可能出现的块数 */
const ROUND_INDEX_STRIDE = 100

/**
 * 单轮里最多处理几个并发工具调用。
 *
 * 模型可能一次发多个（实测见过两个搜索），全部执行才不会让它以为信息不全。
 * 设上限是防止某个异常端点一次吐出几十个调用把合成块 index 用光。
 */
const MAX_PARALLEL = 4

/**
 * 从已到达的 SSE 文本判断这一轮的性质。
 *
 * 返回：
 * - 'tool'：模型要调用工具（已看到 tool_use 块或 stop_reason 为工具）；
 * - 'final'：模型给出了最终回答（stop_reason 是结束类）；
 * - null：还不能判断，需要继续读。
 *
 * 逐行解析而不是对整段做正则：模型的思考文本里可能出现 `"stop_reason":`
 * 这类字面量，正则会误判。只有 SSE 事件对象里的字段才可信。
 */
/**
 * 从已到达的 SSE 文本判断这一轮的性质。
 *
 * 返回：
 * - 'tool'：模型要调用工具；
 * - 'text'：已出现正文块，确定是最终回答（可以立刻转流式）；
 * - 'final'：流结束（stop_reason 是结束类）；
 * - null：还不能判断，继续读。
 *
 * 逐行解析而不是对整段做正则：模型的思考文本里可能出现 `"stop_reason":`
 * 这类字面量，正则会误判。只有 SSE 事件对象里的字段才可信。
 */
const inspectChunk = (
  sseText: string,
  isOpenAI: boolean
): 'tool' | 'text' | 'final' | null => {
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) {
      continue
    }
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') {
      continue
    }
    let event: Record<string, unknown>
    try {
      event = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }

    if (isOpenAI) {
      const choices = event.choices as Record<string, unknown>[] | undefined
      const delta = (choices?.[0]?.delta ?? {}) as Record<string, unknown>
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        return 'tool'
      }
      // 有正文内容即视为最终回答，立刻转流式
      if (typeof delta.content === 'string' && delta.content !== '') {
        return 'text'
      }
      const finish = choices?.[0]?.finish_reason
      if (typeof finish === 'string') {
        return finish === 'tool_calls' ? 'tool' : 'final'
      }
      continue
    }

    // Anthropic：content_block_start 带块类型
    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block?.type === 'tool_use') {
        return 'tool'
      }
      // text 块出现即确定是最终回答
      if (block?.type === 'text') {
        return 'text'
      }
      continue
    }
    // message_delta 带 stop_reason
    if (event.type === 'message_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      const reason = delta?.stop_reason
      if (typeof reason === 'string') {
        return reason === 'tool_use' ? 'tool' : 'final'
      }
    }
  }
  return null
}

/**
 * 工具调用循环：让模型自主决定要不要搜索 / 读网页。
 *
 * 对前端来说这是一条连续的流，中间可能发生多次「模型要工具 → 我们执行 →
 * 结果回灌 → 模型继续」。每次工具调用额外补发一对合成块（搜索用
 * server_tool_use + web_search_tool_result，读网页用 web_fetch_tool_result），
 * 界面上的来源卡片才能正常显示。
 *
 * 流式取舍：判断「这轮是工具调用还是最终回答」不能只看第一个内容块——模型
 * 常先输出 thinking 再发 tool_use，看第一个块会误判。也不能等 stop_reason，
 * 那在流末尾。折中：先在宽限窗口内攒一小段，看到工具信号就转工具轮（丢掉
 * 攒的内容），攒够长度还没有就认定是最终回答、转完全流式。
 */
const runSearchToolLoop = async ({
  initialMessages,
  isOpenAI,
  model,
  callUpstream,
  search,
  fetchPage,
}: {
  initialMessages: unknown[]
  isOpenAI: boolean
  model: string
  /** 第二个参数为 false 时不再声明工具，用于强制模型直接作答 */
  callUpstream: (messages: unknown[], allowTools?: boolean) => Promise<Response>
  /** 未配置搜索服务时为 undefined，此时不声明 search_web 工具 */
  search?: (query: string) => Promise<SearchHit[]>
  /** 未配置抓取地址时为 undefined，此时不声明 read_url 工具 */
  fetchPage?: (url: string) => Promise<{ title: string; content: string }>
}): Promise<ReadableStream<Uint8Array>> => {
  const encoder = new TextEncoder()
  const messages = [...initialMessages]

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string) => controller.enqueue(encoder.encode(text))

      try {
        for (let round = 0; round <= MAX_ROUNDS; round += 1) {
          const lastRound = round === MAX_ROUNDS
          // 最后一轮不再声明工具，强制模型直接作答
          const upstream = await callUpstream(messages, !lastRound)
          const raw = isOpenAI
            ? translateOpenAIStream(upstream.body as ReadableStream<Uint8Array>, model)
            : (upstream.body as ReadableStream<Uint8Array>)

          const reader = raw.getReader()
          const decoder = new TextDecoder()
          /**
           * 判断这一轮是工具调用还是最终回答。
           *
           * 依据是内容块的类型，而不是缓冲区大小或 stop_reason：
           * - 出现 `text` 块 → 确定是最终回答，立刻转流式（首字延迟 = 思考时间，
           *   这是推理模型本来就有的等待，不该额外放大）；
           * - 出现 `tool_use` 块 → 工具轮，整轮丢弃（模型在酝酿参数，不该显示）；
           * - 只有 `thinking` → 还判断不了，继续缓冲。
           *
           * 之前用 128KB 的静默窗口兜底，导致正常长度的回答永远攒不到阈值、
           * 整段吐出，流式完全消失——这就是那个问题的根因。
           */
          let full = ''
          /** 尚未推送的内容；确定是最终回答时先整段推出，之后逐块透传 */
          let pending = ''
          let streaming = false
          let hasToolSignal = false
          let decided = false

          /** 把攒下的内容推出去，之后转为逐块透传 */
          const startStreaming = () => {
            if (streaming) {
              return
            }
            streaming = true
            if (pending !== '') {
              push(shiftSSEIndexes(pending, round * ROUND_INDEX_STRIDE))
              pending = ''
            }
          }

          while (!decided) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            const chunk = decoder.decode(value, { stream: true })
            full += chunk
            pending += chunk

            const verdict = inspectChunk(full, isOpenAI)
            if (verdict === 'tool') {
              hasToolSignal = true
              decided = true
              break
            }
            if (verdict === 'text') {
              // 最终回答：立刻恢复流式
              decided = true
              startStreaming()
              break
            }
            if (verdict === 'final') {
              decided = true
              break
            }
            // 已经开始流式就一直推
            if (streaming && pending !== '') {
              push(shiftSSEIndexes(pending, round * ROUND_INDEX_STRIDE))
              pending = ''
            }
          }

          // 最后一轮强制不再给工具：即便模型还想调，也按最终回答处理
          if (!hasToolSignal || lastRound || !decided) {
            const shift = round * ROUND_INDEX_STRIDE
            // 还没开始流式：这一轮要么是纯思考结尾，要么判定失败，整轮过滤后推出
            if (!streaming) {
              let tail = pending
              for (;;) {
                const { done, value } = await reader.read()
                if (done) {
                  break
                }
                tail += decoder.decode(value, { stream: true })
              }
              push(shiftSSEIndexes(stripToolBlocks(tail), shift))
            } else {
              // 已经在流式：剩余部分直接透传
              for (;;) {
                const { done, value } = await reader.read()
                if (done) {
                  break
                }
                push(shiftSSEIndexes(decoder.decode(value, { stream: true }), shift))
              }
            }
            reader.releaseLock()
            break
          }

          // 工具轮：读完剩余内容（不推给前端，那是模型在酝酿参数）
          let rest = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            rest += decoder.decode(value, { stream: true })
          }
          reader.releaseLock()

          const calls = parseToolRound(full + rest, isOpenAI)
          if (calls.length === 0) {
            /**
             * 检测到工具信号但解析不出参数：说明模型确实想调用，只是参数不完整
             * 或用了不认识的形式。当作最终回答收尾，但要把工具块剔掉，否则
             * 界面上会出现原始 JSON 片段。index 按轮次偏移。
             */
            const shift = round * ROUND_INDEX_STRIDE
            push(shiftSSEIndexes(stripToolBlocks(pending + rest), shift))
            break
          }

          /**
           * 一轮里可能有多个并发的工具调用（实测模型会同时搜两个关键词）。
           * 全部执行、结果按顺序回灌——只回第一个会让模型以为信息不全，继续
           * 反复搜索，很快耗尽轮次。
           */
          const resultTexts: { id: string; text: string }[] = []
          const batch = calls.slice(0, MAX_PARALLEL)
          for (let i = 0; i < batch.length; i += 1) {
            const entry = batch[i]
            const toolUseId = `srvtoolu_relay_${round}_${i}_${Date.now().toString(36)}`
            const syntheticIndex = SYNTHETIC_BLOCK_BASE + (round * MAX_PARALLEL * 2) + i * 2
            const searchQuery = entry.call.name === TOOL_NAME ? searchQueryOf(entry.call) : null
            const readUrl = entry.call.name === READ_TOOL_NAME ? readUrlOf(entry.call) : null

            if (entry.call.name === READ_TOOL_NAME && readUrl && fetchPage) {
              const page = await fetchPage(readUrl).catch(() => null)
              if (page) {
                push(fetchBlocksAsSSE(toolUseId, readUrl, page, syntheticIndex))
                resultTexts.push({
                  id: entry.toolUseId ?? toolUseId,
                  text: `网页 ${readUrl}\n标题：${page.title}\n\n${page.content}`,
                })
              } else {
                resultTexts.push({ id: entry.toolUseId ?? toolUseId, text: `读取 ${readUrl} 失败。` })
              }
            } else if (search && entry.call.name === TOOL_NAME) {
              const query = searchQuery ?? ''
              const hits = query ? await search(query).catch(() => []) : []
              push(searchBlocksAsSSE(toolUseId, query, hits, syntheticIndex))
              resultTexts.push({
                id: entry.toolUseId ?? toolUseId,
                text: formatHitsForTool(hits),
              })
            } else {
              // 未配置对应服务：如实告诉模型，避免它以为拿到了数据
              resultTexts.push({
                id: entry.toolUseId ?? toolUseId,
                text: `工具 ${entry.call.name} 不可用。`,
              })
            }
          }

          /**
           * 收尾指令：接近轮次上限时，把「写总结、别再调工具」作为附加内容塞进
           * 工具结果里。
           *
           * 这是 DeepSeekRuntime 的做法（其 goal-round wrap-up 设计笔记）：不要在
           * 工具结果处硬切断 turn，而是注入一条收尾指令，让模型在同一个 turn 里
           * 再生成一次面向用户的答复，循环靠「没有工具调用」这个普通条件自然结束。
           */
          const wrapUp =
            round + 1 >= MAX_ROUNDS
              ? '\n\n---\n\n资料已经足够。请直接基于以上结果写出面向用户的最终答复：' +
                '给出结论、关键数据与来源，不要再调用任何工具。'
              : ''

          if (isOpenAI) {
            messages.push(
              { role: 'assistant', content: '', tool_calls: calls[0].openAIToolCalls },
              ...resultTexts.map((item) => openAIToolMessage(item.id, item.text + wrapUp))
            )
          } else {
            messages.push(
              { role: 'assistant', content: batch.map((entry) => entry.anthropicToolUse) },
              {
                role: 'user',
                content: resultTexts.map((item) => anthropicToolResult(item.id, item.text + wrapUp)),
              }
            )
          }
        }
        controller.close()
      } catch (error) {
        push(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: String(error) },
          })}\n\n`
        )
        controller.close()
      }
    },
  })
}

/**
 * 解析一轮上游事件，取出工具调用信息。
 *
 * 只认我们声明的 search_web / read_url；其他工具调用（理论上不会有）忽略。
 * 参数可能分片下发（Anthropic 的 input_json_delta），需要拼装后再解析。
 */
const parseToolRound = (
  sseText: string,
  isOpenAI: boolean
): {
  call: ToolCall
  toolUseId?: string
  anthropicToolUse?: unknown
  openAIToolCalls?: unknown[]
}[] => {
  const events = sseText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload !== '' && payload !== '[DONE]')

  if (isOpenAI) {
    /**
     * OpenAI 的 tool_calls 按 index 分片下发，arguments 是 JSON 字符串碎片。
     * 一轮可能有多个（并行调用），全部收集。
     */
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    for (const payload of events) {
      let chunk: Record<string, unknown>
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>
      } catch {
        continue
      }
      const choices = chunk.choices as Record<string, unknown>[] | undefined
      const delta = (choices?.[0]?.delta ?? {}) as Record<string, unknown>
      const list = delta.tool_calls
      if (!Array.isArray(list)) {
        continue
      }
      for (const item of list) {
        const call = item as Record<string, unknown>
        const index = typeof call.index === 'number' ? call.index : 0
        const fn = (call.function ?? {}) as Record<string, unknown>
        const current = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (typeof call.id === 'string' && call.id !== '') {
          current.id = call.id
        }
        if (typeof fn.name === 'string' && fn.name !== '') {
          current.name = fn.name
        }
        if (typeof fn.arguments === 'string') {
          current.arguments += fn.arguments
        }
        calls.set(index, current)
      }
    }
    const all = [...calls.values()].map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }))
    const result: {
      call: ToolCall
      openAIToolCalls?: unknown[]
    }[] = []
    for (const call of calls.values()) {
      const parsed = toolCallFromOpenAI({ function: call })
      if (parsed) {
        result.push({ call: parsed, openAIToolCalls: all })
      }
    }
    return result
  }

  /**
   * Anthropic：tool_use 的参数分两种下发方式。
   *
   * - 部分实现（DeepSeek 中转）在 content_block_start 里就带完整 input；
   * - 标准 Anthropic 只给空 input，参数通过 input_json_delta 逐片拼装。
   *
   * 必须**按 block index 分组**：模型一轮里可能同时发起多个工具调用（实测见过
   * 一次两个搜索），它们的 partial_json 交错下发。若把所有片段拼成一个字符串，
   * 会得到  这种非法 JSON，解析必然失败——
   * 表现就是界面上「已停止」且没有任何结果。
   */
  const blocks = new Map<number, { start: Record<string, unknown>; partial: string }>()
  for (const payload of events) {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }
    const index = typeof event.index === 'number' ? event.index : 0

    if (event.type === 'content_block_start') {
      const started = event.content_block as Record<string, unknown> | undefined
      if (
        started &&
        started.type === 'tool_use' &&
        (started.name === TOOL_NAME || started.name === READ_TOOL_NAME)
      ) {
        blocks.set(index, { start: started, partial: '' })
      }
      continue
    }
    if (event.type === 'content_block_delta') {
      const entry = blocks.get(index)
      if (!entry) {
        continue
      }
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        entry.partial += delta.partial_json
      }
    }
  }

  const result: {
    call: ToolCall
    toolUseId?: string
    anthropicToolUse?: unknown
  }[] = []

  for (const entry of blocks.values()) {
    const toolUseId =
      typeof entry.start.id === 'string' ? entry.start.id : undefined
    // 先在 content_block_start 自带的 input 里找（部分中转直接给全）
    const direct = toolCallFromAnthropic(entry.start)
    if (direct && Object.keys(direct.args).length > 0) {
      result.push({ call: direct, toolUseId, anthropicToolUse: entry.start })
      continue
    }
    // 否则用拼装好的 partial_json
    let input: unknown
    try {
      input = JSON.parse(entry.partial)
    } catch {
      continue
    }
    const completed = { ...entry.start, input }
    const call = toolCallFromAnthropic(completed)
    if (call) {
      result.push({ call, toolUseId, anthropicToolUse: completed })
    }
  }
  return result
}

export const chatRoutes = ({ db }: { db: DatabaseSync }) => {
  /**
   * 搜索配置每次请求现读：设置页保存后立即生效，不必重启服务。
   * settings 表只有一行，读取代价可以忽略。
   */
  const searchConfig = () => readSearchConfig(db)

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
    /** 指定了模型却查不到时，用来区分「没配置」和「被停用了」 */
    const selectAny = db.prepare(`select id, enabled from models where id = ? or model = ? limit 1`)

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
      /**
       * 指定了模型却解析不到：如果这个模型存在但被停用，明确告诉调用方。
       *
       * 不能退回默认模型——那会让用户以为还在用原来的端点，实际计费与效果
       * 都变了。前端据此提示「模型已停用，请重新选择」。
       */
      if (modelId) {
        const existing = selectAny.get(modelId, modelId) as { enabled: number } | undefined
        if (existing && existing.enabled !== 1) {
          throw new HttpError(409, `model "${modelId}" is disabled`)
        }
        throw new HttpError(404, `model "${modelId}" not found`)
      }
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

      /**
       * 搜索能力分两条路，**严格二选一**，不会同时声明两个工具：
       *
       * ① 模型自己支持原生搜索 → 声明上游的内置 web_search，由上游执行。
       *    内置 DeepSeek 端点永远走这条（数据库层强制 native_search = 1）。
       * ② 否则若配了搜索服务 → 把搜索包装成 search_web 工具声明给模型，
       *    模型自主决定要不要调用，我们执行真实的搜索 API 再回灌结果。
       *
       * ②的关键收益：模型像用原生搜索一样自主判断，「你好」不会触发搜索。
       * 之前的做法是"开关一开就无条件搜一遍"，问题就在这里。
       */
      const useNativeSearch = builtin || nativeSearch === true
      const cfg = searchConfig()
      const searchReady = isSearchConfigured(cfg)
      const fetchReady = cfg.fetchUrl.trim() !== '' && cfg.apiKey.trim() !== ''
      /**
       * 是否走我们自己的工具循环。
       *
       * 搜索要「开关打开 + 服务已配」；读取网页只要「抓取地址已配」——
       * 它是独立能力，不受智能搜索开关影响。
       */
      const useCustomSearchTool =
        !useNativeSearch && body.search === true && searchReady
      const useFetchTool = !useNativeSearch && fetchReady
      const useToolLoop = useCustomSearchTool || useFetchTool

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

      /**
       * 单次上游请求。抽成函数是因为工具循环要发多次：
       * 第一次声明工具、模型返回 tool_use，我们执行搜索/抓取后带上 tool_result
       * 再请求一次，直到模型给出最终回答。
       */
      /**
       * 单次上游请求。抽成函数是因为工具循环要发多次。
       *
       * `allowTools` 为 false 时不再声明工具：用在最后一轮，强制模型直接作答
       * 而不是继续调用工具——否则它会一直要求搜索，循环永远收不了尾，还会
       * 把原始的 tool_use 结构当正文推给用户。
       */
      const callUpstream = async (
        messages: unknown[],
        allowTools = true
      ): Promise<Response> => {
        const bodyForCall = { ...body, messages }
        const base = buildUpstreamBody(
          bodyForCall,
          capabilities,
          endpoint.dialect,
          builtin,
          modelConfig,
          nativeSearch,
          allowTools && useCustomSearchTool,
          allowTools && useFetchTool
        )
        const payload = isOpenAI ? toOpenAIBody(bodyForCall, base) : { ...base, stream: true }
        payload.model = model
        if (!builtin && maxOutput) {
          payload.max_tokens = maxOutput
        } else if (builtin) {
          delete payload.max_tokens
        }

        const response = await fetch(target, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: req.signal,
        }).catch((error: unknown) => {
          throw new HttpError(502, `upstream request failed: ${String(error)}`)
        })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new HttpError(response.status, detail || response.statusText, detail)
        }
        const type = response.headers.get('content-type') ?? ''
        if (!type.includes('text/event-stream')) {
          const text = await response.text().catch(() => '')
          throw new HttpError(502, `upstream did not return SSE: ${text.slice(0, 200)}`)
        }
        return response
      }

      const stream = useToolLoop
        ? runSearchToolLoop({
            initialMessages: body.messages as unknown[],
            isOpenAI,
            model,
            callUpstream,
            ...(searchReady ? { search: (query: string) => runSearch(cfg, query, req.signal) } : {}),
            ...(fetchReady ? { fetchPage: (url: string) => runFetch(cfg, url, req.signal) } : {}),
          })
        : (async () => {
            const upstream = await callUpstream(body.messages as unknown[])
            return isOpenAI
              ? translateOpenAIStream(upstream.body as ReadableStream<Uint8Array>, model)
              : (upstream.body as ReadableStream<Uint8Array>)
          })()

      return new Response(await stream, {
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

    /**
     * 供设置页「测试连接」用。
     *
     * 不能只靠 GET /models：那个端点不是所有方言都有。DeepSeek 官方只提供
     * Anthropic 兼容的 Messages 接口，`/anthropic/v1/models` 直接 404——用户
     * 明明 Key 是好的、聊天也正常，点测试却报 Not Found。
     *
     * 所以分两步：先试 GET /models（不产生费用），404/405 之类的「该路径不存在」
     * 再退回一次最小的 messages 请求（1 token 输出），与模型的「测试连接」
     * 走同一条路。认证失败（401/403）直接如实返回，不浪费第二次请求。
     */
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

      if (response.ok) {
        return { ok: true, models: await response.json().catch(() => null) }
      }

      // 认证失败或限流：直接如实上报，不必再发一次真实请求
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        throw new HttpError(response.status, await response.text().catch(() => response.statusText))
      }

      // 该端点没有 /models（DeepSeek 官方就是这种）：退回最小 messages 请求
      const model = db
        .prepare(
          `select model from models where endpoint_id = ? and enabled = 1
           order by is_default desc, position limit 1`
        )
        .get(endpoint.id) as { model: string } | undefined
      if (!model) {
        throw new HttpError(
          400,
          'this endpoint has no /models API and no enabled model to test with'
        )
      }

      const isOpenAI = endpoint.dialect === 'openai'
      const probe = await fetch(
        isOpenAI
          ? buildUrl(endpoint.origin, 'openai', 'chat/completions')
          : buildUrl(endpoint.origin, endpoint.dialect, 'messages'),
        {
          method: 'POST',
          headers: isOpenAI
            ? {
                'content-type': 'application/json',
                authorization: `Bearer ${endpoint.api_key}`,
              }
            : {
                'content-type': 'application/json',
                'x-api-key': endpoint.api_key,
                authorization: `Bearer ${endpoint.api_key}`,
              },
          body: JSON.stringify({
            model: model.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
          }),
        }
      ).catch((error: unknown) => {
        throw new HttpError(502, `request failed: ${String(error)}`)
      })

      if (!probe.ok) {
        throw new HttpError(probe.status, await probe.text().catch(() => probe.statusText))
      }
      return { ok: true, models: null }
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
     * 为会话生成标题。
     *
     * 内置 DeepSeek 端点靠私有的 `title: { enabled: true }` 扩展随主请求一起返回
     * 标题，自定义端点没有这个能力，所以这里单独发一次小请求。
     *
     * 只在**首轮**调用：之后用户可能手动改过标题，不该被覆盖。调用方已经保证
     * 会话标题为空才会走到这里。失败不抛给前端——标题只是锦上添花，不该让
     * 一次失败的标题请求在界面上冒错误提示。
     */
    generateTitle: async (req: Request): Promise<{ title: string | null }> => {
      const body = (await readJson(req)) as {
        modelId?: unknown
        userText?: unknown
        assistantText?: unknown
      }
      if (typeof body.modelId !== 'string' || typeof body.userText !== 'string') {
        return { title: null }
      }

      const { endpoint, model } = resolveEndpoint(body.modelId)
      if (!endpoint.api_key) {
        return { title: null }
      }

      // 只把首轮问答截断后交给模型，控制成本
      const clip = (text: string, limit: number) =>
        text.replace(/\s+/g, ' ').trim().slice(0, limit)
      const question = clip(body.userText, 500)
      const answer =
        typeof body.assistantText === 'string' ? clip(body.assistantText, 500) : ''
      if (question === '') {
        return { title: null }
      }

      const instruction =
        '为下面这段对话起一个标题：不超过 12 个汉字（英文不超过 6 个单词），' +
        '不要引号、句号或「标题：」之类的前缀，直接输出标题本身。\n\n' +
        `用户：${question}\n` +
        (answer === '' ? '' : `助手：${answer}\n`)

      const isOpenAI = endpoint.dialect === 'openai'
      const target = isOpenAI
        ? buildUrl(endpoint.origin, 'openai', 'chat/completions')
        : buildUrl(endpoint.origin, endpoint.dialect, 'messages')

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
          max_tokens: 64,
          messages: [{ role: 'user', content: instruction }],
          // 标题不需要推理，省掉思考过程能快不少
          ...(isOpenAI
            ? { stream: false, reasoning_effort: undefined }
            : { stream: false, thinking: { type: 'disabled' } }),
        }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null)

      if (!response || !response.ok) {
        return { title: null }
      }

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!payload) {
        return { title: null }
      }

      let raw = ''
      if (isOpenAI) {
        const choices = payload.choices as { message?: { content?: unknown } }[] | undefined
        const content = choices?.[0]?.message?.content
        raw = typeof content === 'string' ? content : ''
      } else {
        const content = payload.content as { type?: string; text?: unknown }[] | undefined
        raw = (content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('')
      }

      const title = raw
        .replace(/^[\s"'「『《]+|[\s"'」』》。.!！?？]+$/g, '')
        .replace(/^(标题|题目|Title)\s*[:：]\s*/i, '')
        .split('\n')[0]
        .trim()
        .slice(0, 40)
      return { title: title === '' ? null : title }
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
