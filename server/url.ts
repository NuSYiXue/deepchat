/**
 * 上游 URL 构造。
 *
 * 单独成模块是因为 search.ts 与 routes/chat.ts 都要用它；
 * 放在 chat.ts 里会形成循环依赖。
 */

/**
 * 按方言与 origin 拼出上游路径。
 *
 * 三种情况都要兼容：
 * - deepseek：`{origin}/anthropic/v1/messages`，`/anthropic` 是 DeepSeek 的专属前缀；
 * - anthropic：标准 Anthropic 协议是 `{origin}/v1/messages`，不带 `/anthropic`；
 * - openai：`{origin}/v1/chat/completions`。
 *
 * 另外 origin 可能已经带版本段（用户填 `http://host:port/v1` 很常见），
 * 这时不再重复拼接，否则会得到 `/v1/v1/...`。
 */
export const buildUrl = (origin: string, dialect: string, path: string): string => {
  const base = origin.replace(/\/+$/, '')
  const hasVersion = /\/v\d+$/.test(base)
  if (dialect === 'deepseek') {
    return hasVersion ? `${base}/${path}` : `${base}/anthropic/v1/${path}`
  }
  return hasVersion ? `${base}/${path}` : `${base}/v1/${path}`
}
