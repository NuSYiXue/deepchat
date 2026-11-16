/**
 * 推理档位的读写格式。
 *
 * 采用与 DeepSeekRuntime 一致的 reasoningEfforts 字典：键是档位名，
 * 值是发给上游的 API 参数值；off 表示关闭思考，值为 null。
 *
 *   { "low": "low", "high": "high" }
 *
 * 早期版本存成 `{ kind: 'budget' | 'effort' | 'none', defaultLevel }`，
 * 读取时通过 {@link normalizeEfforts} 兼容，避免升级后界面出现无意义条目。
 */

export type ReasoningEfforts = Record<string, string | null>

/** 档位升级顺序；同时用于 UI 的候选列表与默认档位挑选 */
export const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 把任意存储值转成 reasoningEfforts；无法识别时返回 undefined（视为不推理） */
export const normalizeEfforts = (value: unknown): ReasoningEfforts | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>

  // 旧格式带 kind 字段
  if (typeof record.kind === 'string') {
    if (record.kind === 'none') {
      return undefined
    }
    const level = record.defaultLevel
    if (level === undefined) {
      return undefined
    }
    const name = String(level)
    // 纯数值视为 token 预算，挂到 high 档；其余当档位名
    const numeric = name.trim() !== '' && Number.isFinite(Number(name)) && Number(name) > 0
    return numeric ? { high: name } : { [name]: name }
  }

  // 新格式：只保留合法的映射项
  const efforts: ReasoningEfforts = {}
  for (const [level, wire] of Object.entries(record)) {
    if (typeof wire === 'string' || wire === null) {
      efforts[level] = wire
    }
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/**
 * 从声明的档位里挑本轮要用的一个。
 *
 * 请求显式给了档位且已声明就用它；否则取最高的思考档（跳过 off）。
 * 一个思考档都没有时返回 undefined，表示不发送推理字段。
 */
export const pickLevel = (
  efforts: ReasoningEfforts | undefined,
  requested?: string | number
): { level: string; value: string | null } | undefined => {
  if (!efforts) {
    return undefined
  }
  const declared = Object.entries(efforts)
  if (declared.length === 0) {
    return undefined
  }
  if (requested !== undefined) {
    const name = String(requested)
    if (name in efforts) {
      return { level: name, value: efforts[name] }
    }
  }
  const thinking = declared
    .filter(([level]) => level !== 'off')
    .sort((a, b) => {
      const left = LEVEL_ORDER.indexOf(a[0] as (typeof LEVEL_ORDER)[number])
      const right = LEVEL_ORDER.indexOf(b[0] as (typeof LEVEL_ORDER)[number])
      return left - right
    })
  const chosen = thinking.at(-1)
  return chosen ? { level: chosen[0], value: chosen[1] } : undefined
}
