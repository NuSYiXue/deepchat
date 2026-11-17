/**
 * OpenAI Chat Completions 与 Anthropic Messages 之间的转换。
 *
 * 前端只认 Anthropic SSE，因此 OpenAI 端点的响应必须在这里翻译回同一套事件，
 * 这样 parseEvent.ts 与 UI 完全不用知道上游是谁。
 */
import type { ChatRequestBody } from './chat.ts'

/** Anthropic messages → OpenAI messages；system 提到首条 */
export const toOpenAIMessages = (body: ChatRequestBody): unknown[] => {
  const messages: unknown[] = []
  if (typeof body.system === 'string' && body.system.trim() !== '') {
    messages.push({ role: 'system', content: body.system })
  }
  for (const raw of body.messages as Record<string, unknown>[]) {
    if (raw.role === 'latest_reminder') {
      continue
    }
    if (raw.role !== 'user' && raw.role !== 'assistant') {
      continue
    }
    const content = raw.content
    if (typeof content === 'string') {
      messages.push({ role: raw.role, content })
      continue
    }
    if (!Array.isArray(content)) {
      continue
    }
    // 文本块拼成字符串；图片等块在下游不支持时忽略，避免请求被拒
    const text = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
      )
      .map((block) => block.text)
      .join('\n')
    messages.push({ role: raw.role, content: text })
  }
  return messages
}

/** 组装 OpenAI 请求体 */
export const toOpenAIBody = (
  body: ChatRequestBody,
  upstream: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    model: upstream.model,
    messages: toOpenAIMessages(body),
    stream: true,
    // 让 OpenAI 在流里带上用量，前端才能显示 token 统计
    stream_options: { include_usage: true },
  }
  if (typeof body.max_tokens === 'number') {
    result.max_tokens = body.max_tokens
  }
  if (upstream.reasoning_effort !== undefined) {
    result.reasoning_effort = upstream.reasoning_effort
  }
  return result
}

/** 从 OpenAI 的 SSE chunk 里取出文本增量与元信息 */
export const readOpenAIChunk = (
  chunk: unknown
): {
  text?: string
  reasoning?: string
  finish?: string
  usage?: { input_tokens: number; output_tokens: number }
} => {
  if (typeof chunk !== 'object' || chunk === null) {
    return {}
  }
  const value = chunk as Record<string, unknown>
  const usage = value.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined
  const choice = Array.isArray(value.choices)
    ? (value.choices[0] as Record<string, unknown> | undefined)
    : undefined
  const delta = (choice?.delta ?? {}) as Record<string, unknown>
  return {
    text: typeof delta.content === 'string' ? delta.content : undefined,
    // 部分推理模型把思考过程放在 reasoning_content
    reasoning:
      typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined,
    finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
    usage:
      usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
        ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }
        : undefined,
  }
}

const STOP_REASONS: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
}

/** OpenAI finish_reason → Anthropic stop_reason */
export const toStopReason = (finish: string | undefined): string =>
  (finish && STOP_REASONS[finish]) || 'end_turn'

const sse = (event: string, data: unknown): Uint8Array =>
  new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

/**
 * 把 OpenAI 的 SSE 流转成 Anthropic SSE。
 *
 * 只产出前端能消费的事件：message_start、content_block_start/delta/stop、
 * message_delta、message_stop。上游的 [DONE] 标记不转发。
 */
export const translateOpenAIStream = (
  source: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> => {
  let buffer = ''
  let blockIndex = -1
  let openedText = false
  let openedThinking = false
  let sawUsage: { input_tokens: number; output_tokens: number } | undefined

  const closeBlocks = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (openedThinking) {
      controller.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }))
      openedThinking = false
      blockIndex += 1
    }
    if (openedText) {
      controller.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }))
      openedText = false
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      const decoder = new TextDecoder()
      controller.enqueue(
        sse('message_start', {
          type: 'message_start',
          message: { id: `msg_${Date.now()}`, model },
        })
      )

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
            let chunk: unknown
            try {
              chunk = JSON.parse(payload)
            } catch {
              continue
            }
            const part = readOpenAIChunk(chunk)
            if (part.usage) {
              sawUsage = part.usage
            }
            if (part.reasoning) {
              if (!openedThinking) {
                blockIndex += 1
                openedThinking = true
                controller.enqueue(
                  sse('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'thinking', thinking: '' },
                  })
                )
              }
              controller.enqueue(
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'thinking_delta', thinking: part.reasoning },
                })
              )
            }
            if (part.text) {
              if (!openedText) {
                blockIndex += 1
                openedText = true
                controller.enqueue(
                  sse('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'text', text: '' },
                  })
                )
              }
              controller.enqueue(
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: part.text },
                })
              )
            }
            if (part.finish) {
              closeBlocks(controller)
              controller.enqueue(
                sse('message_delta', {
                  type: 'message_delta',
                  delta: { stop_reason: toStopReason(part.finish), stop_sequence: null },
                  ...(sawUsage ? { usage: { ...sawUsage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } : {}),
                })
              )
              controller.enqueue(sse('message_stop', { type: 'message_stop' }))
              controller.close()
              return
            }
          }
        }
        // 流正常结束但没收到 finish_reason：按 end_turn 收尾，避免前端卡在生成中
        closeBlocks(controller)
        controller.enqueue(
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
          })
        )
        controller.enqueue(sse('message_stop', { type: 'message_stop' }))
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}
