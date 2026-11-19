import type {
  ContentBlockDelta,
  MessageStreamEvent,
  OutputBlockStart,
  TextCitation,
} from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'
const isOptionalString = (value: unknown) => value === undefined || isString(value)
const isNullableString = (value: unknown) => value == null || isString(value)
const isIndex = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0

const isCitation = (value: unknown): value is TextCitation =>
  isRecord(value) &&
  value.type === 'web_search_result_location' &&
  isString(value.url) &&
  isNullableString(value.title)

/** 只检查消费内容所需的字段，签名及服务端附带的信息保持原样。 */
const readBlock = (value: unknown): OutputBlockStart | null => {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'text':
      if (!isString(value.text)) {
        return null
      }
      return {
        ...value,
        type: 'text',
        text: value.text,
        ...(value.citations === undefined
          ? {}
          : {
              citations: Array.isArray(value.citations) ? value.citations.filter(isCitation) : [],
            }),
      }
    case 'thinking':
      if (!isString(value.thinking)) {
        return null
      }
      return {
        ...value,
        signature: isOptionalString(value.signature) ? value.signature : undefined,
      } as OutputBlockStart
    case 'server_tool_use': {
      const input = value.input
      if (!isString(value.id) || !isRecord(input)) {
        return null
      }
      /**
       * 两种来源要同时认：
       * - DeepSeek 私有格式：name 是 deepseek_web_search / deepseek_read_url，
       *   带 kind 字段，input.action 决定结构；
       * - 标准 Anthropic 格式：name 是 web_search，没有 kind，input 是 { query }。
       *
       * 后者归一化成前者，下游 view.ts / toArchive.ts 只需处理一种形状。
       */
      const isDeepSeekTool =
        value.name === 'deepseek_web_search' || value.name === 'deepseek_read_url'
      if (isDeepSeekTool) {
        if (
          !['search', 'deep_search', 'read_link', 'image_search', 'deep_image_search'].includes(
            value.kind as string
          )
        ) {
          return null
        }
        switch (input.action) {
          case 'search':
            if (!Array.isArray(input.queries) || !input.queries.every(isString)) {
              return null
            }
            break
          case 'open_page':
          case 'read_link':
            if (!isString(input.url)) {
              return null
            }
            break
          case 'find_in_page':
            if (!isString(input.url) || !isString(input.pattern)) {
              return null
            }
            break
          default:
            return null
        }
        break
      }

      // 标准 Anthropic web_search：把 { query } 折成 { action: 'search', queries }
      if (value.name === 'web_search' && isString(input.query)) {
        return {
          ...value,
          kind: 'search',
          caller: { type: 'direct' },
          input: { action: 'search', queries: [input.query] },
        } as OutputBlockStart
      }
      return null
    }
    case 'web_search_tool_result':
      if (
        !isString(value.tool_use_id) ||
        !Array.isArray(value.content) ||
        // 标准 Anthropic 的结果块没有 kind，补成 'search'
        (value.kind !== undefined &&
          !['search', 'deep_search', 'image_search', 'deep_image_search'].includes(
            value.kind as string
          ))
      ) {
        return null
      }
      return {
        ...value,
        kind: value.kind === undefined ? 'search' : value.kind,
        content: value.content.filter((item) => {
          if (!isRecord(item)) {
            return false
          }
          if (item.type === 'web_search_tool_result_error') {
            return isString(item.error_code)
          }
          return (
            item.type === 'web_search_result' &&
            isString(item.url) &&
            isString(item.title) &&
            isNullableString(item.snippet) &&
            isNullableString(item.site_name) &&
            isNullableString(item.site_icon) &&
            isNullableString(item.page_age)
          )
        }),
      } as OutputBlockStart
    case 'web_fetch_tool_result': {
      const content = value.content
      if (
        !isString(value.tool_use_id) ||
        !['read_link', 'deep_search'].includes(value.kind as string) ||
        !isRecord(content)
      ) {
        return null
      }
      if (content.type === 'web_fetch_tool_result_error') {
        if (!isString(content.error_code)) {
          return null
        }
      } else if (
        content.type !== 'web_fetch_result' ||
        !isString(content.url) ||
        !isRecord(content.content) ||
        !isNullableString(content.content.title) ||
        !isNullableString(content.published_at)
      ) {
        return null
      }
      return {
        ...value,
        signature: isOptionalString(value.signature) ? value.signature : undefined,
      } as OutputBlockStart
    }
    case 'tool_use':
      // 不展示客户端工具内容；交给回复归并层关闭这条回复的续写能力。
      break
    default:
      return null
  }
  return value as OutputBlockStart
}

const readDelta = (value: unknown): ContentBlockDelta | null => {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'text_delta':
      return isString(value.text) ? (value as ContentBlockDelta) : null
    case 'thinking_delta':
      return isString(value.thinking) ? (value as ContentBlockDelta) : null
    case 'signature_delta':
      return isString(value.signature) ? (value as ContentBlockDelta) : null
    case 'citations_delta':
      return isCitation(value.citation) ? (value as ContentBlockDelta) : null
    default:
      return null
  }
}

const isUsage = (value: unknown) =>
  isRecord(value) &&
  ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].every(
    (key) => typeof value[key] === 'number' && Number.isFinite(value[key])
  )

/** 未识别或无法安全消费的事件静默丢弃，不影响后续有效内容与正常结束。 */
export const readMessageEvent = (value: unknown): MessageStreamEvent | null => {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'message_start':
      if (!isRecord(value.message)) {
        return null
      }
      return {
        ...value,
        message: {
          ...value.message,
          usage: isUsage(value.message.usage) ? value.message.usage : undefined,
        },
      } as MessageStreamEvent
    case 'content_block_start': {
      const block = readBlock(value.content_block)
      return isIndex(value.index) && block
        ? { type: 'content_block_start', index: value.index as number, content_block: block }
        : null
    }
    case 'content_block_delta': {
      const delta = readDelta(value.delta)
      return isIndex(value.index) && delta
        ? { type: 'content_block_delta', index: value.index as number, delta }
        : null
    }
    case 'content_block_stop':
      if (!isIndex(value.index)) {
        return null
      }
      break
    case 'message_delta':
      if (
        !isRecord(value.delta) ||
        !['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(
          value.delta.stop_reason as string
        )
      ) {
        return null
      }
      return {
        ...value,
        delta: {
          ...value.delta,
          title: isOptionalString(value.delta.title) ? value.delta.title : undefined,
        },
        usage: isUsage(value.usage) ? value.usage : undefined,
      } as MessageStreamEvent
    case 'message_stop':
      break
    default:
      return null
  }
  return value as MessageStreamEvent
}
