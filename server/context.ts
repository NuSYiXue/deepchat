/**
 * 上下文预算裁剪。
 *
 * 服务端知道每个模型的 maxContext，因此裁剪放在服务端做：前端不必关心不同
 * 模型的窗口大小，也不必为此引入 tokenizer。
 *
 * 估算方式：中日韩字符按 1 字 ≈ 1 token，其他字符按 4 字符 ≈ 1 token。
 * 这是粗略近似，但足以避免请求被上游以「超长」拒绝；真正的上限仍由服务端校验。
 */

/** 粗略估算一段文本的 token 数 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    // CJK 统一表意文字、假名、谚文，以及全角标点
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/** 一条 Anthropic messages 元素的估算长度 */
const estimateMessage = (message: Record<string, unknown>): number => {
  const content = message.content
  if (typeof content === 'string') {
    return estimateTokens(content)
  }
  if (!Array.isArray(content)) {
    return 0
  }
  let total = 0
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue
    }
    const value = block as Record<string, unknown>
    if (typeof value.text === 'string') {
      total += estimateTokens(value.text)
    } else if (typeof value.thinking === 'string') {
      total += estimateTokens(value.thinking)
    } else if (value.type === 'image' || value.type === 'document') {
      /**
       * 内联附件的 base64 负载不能按字符数估算：它的长度取决于文件大小，
       * 与 token 消耗无关。按 Anthropic 的换算，一张图约 (宽×高)/750 个
       * token，未知尺寸时按常见尺寸给一个保守值；文档按页数粗估。
       */
      total += estimateAttachmentTokens(value.source as Record<string, unknown> | undefined)
    } else {
      // 工具结果、file_id 引用等按固定开销计
      total += 100
    }
  }
  return total
}

/** 附件块的开销：base64 内联按经验值，file_id 引用本身几乎不占上下文 */
const estimateAttachmentTokens = (source: Record<string, unknown> | undefined): number => {
  if (source?.type !== 'base64') {
    return 100
  }
  const data = typeof source.data === 'string' ? source.data : ''
  // base64 每 4 字符对应 3 字节；文档按每页 ~1.5k token 估，图片按上限 1.6k
  const bytes = Math.ceil((data.length * 3) / 4)
  return bytes > 2_000_000 ? 8_000 : 1_600
}

/**
 * 从最早的轮次开始丢弃，直到落在预算内。
 *
 * 保留顺序为「最新优先」：最后一条提问永远保留，历史整轮成对丢弃，
 * 避免出现只有 user 没有 assistant 的孤立半轮。
 */
export const trimMessages = <T extends { role: string; content?: unknown }>(
  messages: T[],
  maxTokens: number,
  reserveForOutput = 0
): { messages: T[]; trimmed: number; estimated: number } => {
  const budget = Math.max(0, maxTokens - reserveForOutput)
  const sizes = messages.map((message) => estimateMessage(message as Record<string, unknown>))
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= budget) {
    return { messages, trimmed: 0, estimated: total }
  }

  // 从前往后找可以安全丢弃的位置：只丢「提问 + 回答」成对的轮次
  const keep: T[] = []
  let used = 0
  // 倒序累积，保证最新的内容优先保留
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = sizes[i]
    if (used + size > budget && keep.length > 0) {
      break
    }
    keep.unshift(messages[i])
    used += size
  }

  // 丢弃后首条若是 assistant（没有配对的提问），一并去掉
  while (keep.length > 0 && keep[0].role !== 'user') {
    keep.shift()
  }
  return { messages: keep, trimmed: messages.length - keep.length, estimated: total }
}
