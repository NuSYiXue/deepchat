/**
 * 配置相关的路由：人设、端点、模型、设置。
 *
 * API Key 只入不出：返回给前端时替换成 hasKey 标记与尾部提示，
 * 避免密钥随 GET 响应进入浏览器缓存或前端 DevTools 历史。
 */
import type { DatabaseSync } from 'node:sqlite'
import { HttpError, assertCleanText, readJson } from '../http.ts'
import { normalizeEfforts } from '../reasoning.ts'
import {
  DEFAULT_PERSONA_ID,
  listEndpoints,
  listModels,
  listPersonas,
  transaction,
  type FileRow,
} from '../db.ts'

type EndpointRow = {
  id: string
  name: string
  origin: string
  api_key: string
  dialect: string
  capabilities: string
  builtin: number
}

const keyHint = (key: string): string =>
  key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`

const presentEndpoint = (row: EndpointRow) => ({
  id: row.id,
  name: row.name,
  origin: row.origin,
  dialect: row.dialect,
  capabilities: JSON.parse(row.capabilities) as Record<string, unknown>,
  hasKey: row.api_key !== '',
  keyHint: row.api_key === '' ? null : keyHint(row.api_key),
  builtin: row.builtin === 1,
})

const upsertEndpoint = (
  db: DatabaseSync,
  body: {
    id?: unknown
    name?: unknown
    origin?: unknown
    apiKey?: unknown
    dialect?: unknown
    capabilities?: unknown
  }
): string => {
  if (typeof body.id !== 'string' || body.id === '') {
    throw new HttpError(400, 'id is required')
  }
  if (typeof body.name !== 'string' || typeof body.origin !== 'string') {
    throw new HttpError(400, 'name and origin are required')
  }
  if (!/^https?:\/\//.test(body.origin)) {
    throw new HttpError(400, 'origin must start with http:// or https://')
  }
  const dialect =
    body.dialect === 'anthropic' || body.dialect === 'openai' ? body.dialect : 'deepseek'
  const capabilities = JSON.stringify(body.capabilities ?? {})
  const current = db
    .prepare(`select api_key, builtin, name, origin, dialect, capabilities from endpoints where id = ?`)
    .get(body.id) as
    | {
        api_key: string
        builtin: number
        name: string
        origin: string
        dialect: string
        capabilities: string
      }
    | undefined

  // 内置端点只允许改 API Key：其余字段一律沿用已保存值，避免被接口改坏
  if (current?.builtin === 1) {
    db.prepare(`update endpoints set api_key = ? where id = ?`).run(
      typeof body.apiKey === 'string' ? body.apiKey : current.api_key,
      body.id
    )
    return body.id
  }

  // apiKey 缺省表示「保持不变」，空字符串才是清空
  const apiKey =
    typeof body.apiKey === 'string' ? body.apiKey : (current?.api_key ?? '')

  db.prepare(
    `insert into endpoints (id, name, origin, api_key, dialect, capabilities)
     values (?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       name = excluded.name,
       origin = excluded.origin,
       api_key = excluded.api_key,
       dialect = excluded.dialect,
       capabilities = excluded.capabilities`
  ).run(body.id, body.name, body.origin.replace(/\/+$/, ''), apiKey, dialect, capabilities)
  return body.id
}

const upsertModel = (
  db: DatabaseSync,
  body: Record<string, unknown>
): string => {
  if (typeof body.id !== 'string' || typeof body.endpointId !== 'string') {
    throw new HttpError(400, 'id and endpointId are required')
  }
  if (typeof body.model !== 'string' || body.model === '') {
    throw new HttpError(400, 'model is required')
  }
  // 内置端点的模型由程序固定，不接受新增或修改
  const owner = db
    .prepare(`select builtin from endpoints where id = ?`)
    .get(body.endpointId) as { builtin: number } | undefined
  if (owner?.builtin === 1) {
    throw new HttpError(400, 'models of the built-in endpoint are fixed')
  }
  db.prepare(
    `insert into models
       (id, endpoint_id, name, model, input_types, max_context, max_output, reasoning, is_default, position, native_search, enabled)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       endpoint_id = excluded.endpoint_id,
       name = excluded.name,
       model = excluded.model,
       input_types = excluded.input_types,
       max_context = excluded.max_context,
       max_output = excluded.max_output,
       reasoning = excluded.reasoning,
       is_default = excluded.is_default,
       position = excluded.position,
       native_search = excluded.native_search,
       enabled = excluded.enabled`
  ).run(
    body.id,
    body.endpointId,
    typeof body.name === 'string' && body.name !== '' ? body.name : body.model,
    body.model,
    JSON.stringify(Array.isArray(body.inputTypes) ? body.inputTypes : ['text']),
    typeof body.maxContext === 'number' ? Math.trunc(body.maxContext) : 64000,
    typeof body.maxOutput === 'number' ? Math.trunc(body.maxOutput) : 8192,
    JSON.stringify(body.reasoning ?? {}),
    body.isDefault === true ? 1 : 0,
    typeof body.position === 'number' ? Math.trunc(body.position) : 0,
    body.nativeSearch === true ? 1 : 0,
    body.enabled === false ? 0 : 1
  )
  if (body.isDefault === true) {
    db.prepare(`update models set is_default = 0 where id <> ?`).run(body.id)
  }
  return body.id
}

const upsertPersona = (db: DatabaseSync, body: Record<string, unknown>): string => {
  if (typeof body.id !== 'string' || body.id === '') {
    throw new HttpError(400, 'id is required')
  }
  if (body.id === DEFAULT_PERSONA_ID) {
    throw new HttpError(400, 'the default persona cannot be overwritten')
  }
  if (typeof body.name !== 'string' || typeof body.prompt !== 'string') {
    throw new HttpError(400, 'name and prompt are required')
  }
  assertCleanText(body.name, 'name')
  assertCleanText(body.prompt, 'prompt')
  db.prepare(
    `insert into personas (id, name, prompt, builtin, position) values (?, ?, ?, 0, ?)
     on conflict(id) do update set name = excluded.name, prompt = excluded.prompt, position = excluded.position`
  ).run(
    body.id,
    body.name,
    body.prompt,
    typeof body.position === 'number' ? Math.trunc(body.position) : 0
  )
  return body.id
}

export const configRoutes = ({ db }: { db: DatabaseSync }) => ({
  read: () => ({
    personas: listPersonas(db),
    endpoints: (listEndpoints(db) as EndpointRow[]).map(presentEndpoint),
    models: (listModels(db) as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      endpointId: row.endpoint_id,
      name: row.name,
      model: row.model,
      inputTypes: JSON.parse(row.input_types as string),
      maxContext: row.max_context,
      maxOutput: row.max_output,
      reasoning: normalizeEfforts(JSON.parse(row.reasoning as string)) ?? {},
      nativeSearch: row.native_search === 1,
      enabled: row.enabled === 1,
      isDefault: row.is_default === 1,
    })),
    settings: Object.fromEntries(
      (db.prepare(`select key, value from settings`).all() as { key: string; value: string }[]).map(
        (row) => [row.key, row.value]
      )
    ),
  }),

  saveEndpoint: async (req: Request) =>
    ({ id: upsertEndpoint(db, await readJson(req)) }),

  saveModel: async (req: Request) =>
    ({ id: upsertModel(db, await readJson(req)) }),

  savePersona: async (req: Request) =>
    ({ id: upsertPersona(db, await readJson(req)) }),

  deletePersona: (id: string) => {
    if (id === DEFAULT_PERSONA_ID) {
      throw new HttpError(400, 'the default persona cannot be deleted')
    }
    db.prepare(`delete from personas where id = ?`).run(id)
    // 引用该人设的会话退回默认
    db.prepare(`update sessions set persona_id = ? where persona_id = ?`).run(
      DEFAULT_PERSONA_ID,
      id
    )
    return { ok: true }
  },

  deleteModel: (id: string) => {
    // 内置端点的模型由程序固定，不接受删除
    const owner = db
      .prepare(
        `select e.builtin as builtin from models m
         join endpoints e on e.id = m.endpoint_id
         where m.id = ?`
      )
      .get(id) as { builtin: number } | undefined
    if (owner?.builtin === 1) {
      throw new HttpError(400, 'models of the built-in endpoint are fixed')
    }
    db.prepare(`delete from models where id = ?`).run(id)
    db.prepare(`update sessions set model_id = null where model_id = ?`).run(id)
    return { ok: true }
  },

  /**
   * 删除端点，连带它的模型。
   *
   * 模型表对 endpoints 有外键级联，但这里显式删除以便同时把引用了这些模型的
   * 会话重置回默认，否则会话会指向已不存在的配置。
   */
  deleteEndpoint: (id: string) => {
    const target = db.prepare(`select builtin from endpoints where id = ?`).get(id) as
      | { builtin: number }
      | undefined
    if (target?.builtin === 1) {
      throw new HttpError(400, 'the built-in DeepSeek endpoint cannot be deleted')
    }
    transaction(db, () => {
      const models = db.prepare(`select id from models where endpoint_id = ?`).all(id) as {
        id: string
      }[]
      for (const model of models) {
        db.prepare(`update sessions set model_id = null where model_id = ?`).run(model.id)
      }
      db.prepare(`delete from models where endpoint_id = ?`).run(id)
      db.prepare(`delete from endpoints where id = ?`).run(id)
    })
    return { ok: true }
  },

  putSetting: async (req: Request) => {
    const body = await readJson<{ key?: unknown; value?: unknown }>(req)
    if (typeof body.key !== 'string' || typeof body.value !== 'string') {
      throw new HttpError(400, 'key and value are required')
    }
    db.prepare(
      `insert into settings (key, value) values (?, ?)
       on conflict(key) do update set value = excluded.value`
    ).run(body.key, body.value)
    return { ok: true }
  },
})

export type ConfigRoutes = ReturnType<typeof configRoutes>
export type { FileRow }
