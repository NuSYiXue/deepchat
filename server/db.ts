/**
 * SQLite 存储层。
 *
 * 服务端是唯一写者，因此保存会话采用「整会话覆盖」：一个事务内删掉该会话的全部
 * 消息再按当前快照写回。这比逐条 diff 简单，也不需要处理并发覆盖。
 *
 * 使用 Node 内置的 node:sqlite，避免 better-sqlite3 的原生编译依赖，
 * 镜像里不需要构建工具链。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

/** 内置默认人设，对应原项目里硬编码的那条 system prompt */
export const DEFAULT_PERSONA_ID = '__default__'

const SCHEMA = `
pragma journal_mode = WAL;
pragma foreign_keys = ON;
pragma busy_timeout = 5000;

create table if not exists sessions (
  id              text primary key,
  title           text not null default '',
  created_at      integer not null,
  updated_at      integer not null,
  persona_id      text not null default '__default__',
  model_id        text,
  root_message_id text,
  -- 区分「线性消息列表」（null 表示未记录）与「空会话」；1 表示 rootMessageId 为空值
  root_is_null    integer not null default 0
);

create table if not exists messages (
  id                text primary key,
  session_id        text not null references sessions(id) on delete cascade,
  parent_id         text,
  selected_child_id text,
  role              text not null,
  status            text,
  payload           text not null,
  created_at        integer not null
);
create index if not exists messages_session on messages(session_id);
create index if not exists messages_parent on messages(parent_id);

create table if not exists personas (
  id        text primary key,
  name      text not null,
  prompt    text not null,
  builtin   integer not null default 0,
  position  integer not null default 0
);

create table if not exists endpoints (
  id           text primary key,
  name         text not null,
  origin       text not null,
  api_key      text not null default '',
  dialect      text not null default 'deepseek',
  capabilities text not null default '{}'
);

create table if not exists models (
  id          text primary key,
  endpoint_id text not null references endpoints(id) on delete cascade,
  name        text not null,
  model       text not null,
  input_types text not null default '["text"]',
  max_context integer not null default 64000,
  max_output  integer not null default 8192,
  reasoning   text not null default '{"kind":"none"}',
  is_default  integer not null default 0,
  position    integer not null default 0
);

create table if not exists files (
  id         text primary key,
  name       text not null,
  size       integer not null,
  mime       text not null,
  server_id  text,
  created_at integer not null
);

create table if not exists settings (
  key   text primary key,
  value text not null
);
`

/** 内置人设：保持原项目的行为不变 */
const DEFAULT_PERSONA_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

export type SessionRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
  persona_id: string
  model_id: string | null
  root_message_id: string | null
  root_is_null: number
}

export type MessageRow = {
  id: string
  session_id: string
  parent_id: string | null
  selected_child_id: string | null
  role: string
  status: string | null
  payload: string
  created_at: number
}

export type FileRow = {
  id: string
  name: string
  size: number
  mime: string
  server_id: string | null
  created_at: number
}

export const openDatabase = (dataDir: string): DatabaseSync => {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'app.db'))
  db.exec(SCHEMA)
  db.prepare(
    `insert or ignore into personas (id, name, prompt, builtin, position) values (?, ?, ?, 1, 0)`
  ).run(DEFAULT_PERSONA_ID, '默认', DEFAULT_PERSONA_PROMPT)
  return db
}

export type SeedConfig = {
  /** DeepSeek API Key；存在时自动创建官方端点与默认模型 */
  deepseekApiKey?: string
  /** 自定义端点；与 key 同时提供时作为默认模型 */
  apiOrigin?: string
  apiModel?: string
}

/**
 * 首次启动时按环境变量播种端点与模型，让服务开箱即可对话。
 *
 * 只在完全没有端点时写入：已有配置（包括用户后来在设置里改过的）不会被覆盖，
 * 因此重启服务不会把 Key 重置回环境变量里的值。
 */
export const seedEndpoints = (db: DatabaseSync, seed: SeedConfig): void => {
  const existing = db.prepare(`select count(*) as count from endpoints`).get() as { count: number }
  if (existing.count > 0) {
    return
  }
  const apiKey = seed.deepseekApiKey?.trim()
  if (!apiKey) {
    return
  }
  const origin = seed.apiOrigin?.trim() || 'https://api.deepseek.com'
  const model = seed.apiModel?.trim() || 'deepseek-flash'
  const isOfficial = origin === 'https://api.deepseek.com'

  transaction(db, () => {
    db.prepare(
      `insert into endpoints (id, name, origin, api_key, dialect, capabilities)
       values (?, ?, ?, ?, ?, ?)`
    ).run(
      'default',
      isOfficial ? 'DeepSeek' : '自定义端点',
      origin,
      apiKey,
      'deepseek',
      JSON.stringify({
        latestReminder: isOfficial,
        safetyCheck: isOfficial,
        titleExtension: isOfficial,
        filesApi: isOfficial,
      })
    )
    db.prepare(
      `insert into models
         (id, endpoint_id, name, model, input_types, max_context, max_output, reasoning, is_default, position)
       values (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
    ).run(
      'default',
      'default',
      model,
      model,
      JSON.stringify(['text', 'image', 'document']),
      64000,
      8192,
      JSON.stringify({ kind: 'none' })
    )
  })
}

/** 单次事务；失败时回滚并重新抛出 */
export const transaction = <T>(db: DatabaseSync, run: () => T): T => {
  db.exec('begin')
  try {
    const result = run()
    db.exec('commit')
    return result
  } catch (error) {
    try {
      db.exec('rollback')
    } catch {
      // 事务已因错误中止
    }
    throw error
  }
}

const toSummary = (row: SessionRow) => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const listSessionSummaries = (db: DatabaseSync) =>
  (db.prepare(`select * from sessions order by updated_at desc`).all() as SessionRow[]).map(
    toSummary
  )

export type StoredSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  personaId: string
  modelId: string | null
  messages: unknown[]
  rootMessageId?: string | null
}

export const loadSession = (db: DatabaseSync, id: string): StoredSession | undefined => {
  const row = db.prepare(`select * from sessions where id = ?`).get(id) as SessionRow | undefined
  if (!row) {
    return undefined
  }
  const messages = db
    .prepare(`select * from messages where session_id = ? order by rowid`)
    .all(id) as MessageRow[]
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    personaId: row.persona_id,
    modelId: row.model_id,
    messages: messages.map((message) => JSON.parse(message.payload) as unknown),
    // undefined 表示线性列表，null 表示空会话；两者语义不同，必须原样还原
    rootMessageId: row.root_is_null === 1 ? null : (row.root_message_id ?? undefined),
  }
}

/** 整会话覆盖保存；payload 原样保存前端传回的消息对象 */
export const saveSession = (db: DatabaseSync, session: StoredSession): void => {
  transaction(db, () => {
    const rootIsNull = session.rootMessageId === null
    db.prepare(
      `insert into sessions
         (id, title, created_at, updated_at, persona_id, model_id, root_message_id, root_is_null)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         title = excluded.title,
         updated_at = excluded.updated_at,
         persona_id = excluded.persona_id,
         model_id = excluded.model_id,
         root_message_id = excluded.root_message_id,
         root_is_null = excluded.root_is_null`
    ).run(
      session.id,
      session.title ?? '',
      Math.trunc(session.createdAt),
      Math.trunc(session.updatedAt),
      session.personaId ?? DEFAULT_PERSONA_ID,
      session.modelId ?? null,
      typeof session.rootMessageId === 'string' ? session.rootMessageId : null,
      rootIsNull ? 1 : 0
    )

    db.prepare(`delete from messages where session_id = ?`).run(session.id)
    const insert = db.prepare(
      `insert into messages (id, session_id, parent_id, selected_child_id, role, status, payload, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const raw of session.messages as Record<string, unknown>[]) {
      const role = typeof raw.role === 'string' ? raw.role : 'user'
      insert.run(
        String(raw.id),
        session.id,
        typeof raw.parentId === 'string' ? raw.parentId : null,
        typeof raw.selectedChildId === 'string' ? raw.selectedChildId : null,
        role,
        typeof raw.status === 'string' ? raw.status : null,
        JSON.stringify(raw),
        typeof raw.createdAt === 'number' ? Math.trunc(raw.createdAt) : Date.now()
      )
    }
  })
}

export const renameSession = (db: DatabaseSync, id: string, title: string): void => {
  db.prepare(`update sessions set title = ? where id = ?`).run(title, id)
}

export const deleteSession = (db: DatabaseSync, id: string): void => {
  transaction(db, () => {
    db.prepare(`delete from messages where session_id = ?`).run(id)
    db.prepare(`delete from sessions where id = ?`).run(id)
  })
}

export const clearSessions = (db: DatabaseSync): void => {
  transaction(db, () => {
    db.prepare(`delete from messages`).run()
    db.prepare(`delete from sessions`).run()
  })
}

export const listFiles = (db: DatabaseSync, ids: string[]): FileRow[] =>
  ids.length === 0
    ? []
    : (db
        .prepare(`select * from files where id in (${ids.map(() => '?').join(',')})`)
        .all(...ids) as FileRow[])

export const saveFile = (db: DatabaseSync, file: FileRow): void => {
  db.prepare(
    `insert into files (id, name, size, mime, server_id, created_at) values (?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       server_id = coalesce(excluded.server_id, files.server_id)`
  ).run(file.id, file.name, file.size, file.mime, file.server_id, file.created_at)
}

export const loadFileRow = (db: DatabaseSync, id: string): FileRow | undefined =>
  db.prepare(`select * from files where id = ?`).get(id) as FileRow | undefined

export const setFileServerId = (db: DatabaseSync, id: string, serverId: string): void => {
  db.prepare(`update files set server_id = ? where id = ?`).run(serverId, id)
}

export const deleteUnreferencedFiles = (db: DatabaseSync, fileIds: string[]): void => {
  if (fileIds.length === 0) {
    return
  }
  db.prepare(`delete from files where id in (${fileIds.map(() => '?').join(',')})`).run(...fileIds)
}

export const listPersonas = (db: DatabaseSync) =>
  db.prepare(`select * from personas order by builtin desc, position, name`).all()

export const listEndpoints = (db: DatabaseSync) =>
  db.prepare(`select * from endpoints order by name`).all()

export const listModels = (db: DatabaseSync) =>
  db.prepare(`select * from models order by position, name`).all()

export { DEFAULT_PERSONA_PROMPT }
