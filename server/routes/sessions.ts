/**
 * 会话与附件相关的路由。
 *
 * 接口形状对齐前端原有的 db.ts：前端把 IndexedDB 换成本文件的 HTTP 实现时，
 * 函数签名不需要改。保存会话仍是「整会话覆盖」，服务端是唯一写者。
 */
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError, assertCleanText, noContent, readJson } from '../http.ts'
import {
  clearSessions,
  deleteSession,
  deleteUnreferencedFiles,
  listSessionSummaries,
  listFiles,
  loadFileRow,
  loadSession,
  renameSession,
  saveFile,
  saveSession,
  type StoredSession,
} from '../db.ts'

type Deps = { db: DatabaseSync; filesDir: string }

const assertSession = (value: unknown): StoredSession => {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, 'session must be an object')
  }
  const session = value as Record<string, unknown>
  if (typeof session.id !== 'string' || session.id === '') {
    throw new HttpError(400, 'session.id is required')
  }
  if (!Array.isArray(session.messages)) {
    throw new HttpError(400, 'session.messages must be an array')
  }
  if (typeof session.createdAt !== 'number' || typeof session.updatedAt !== 'number') {
    throw new HttpError(400, 'session.createdAt / updatedAt must be numbers')
  }
  return value as StoredSession
}

/** 从会话快照里收集引用的附件 id，用于保存后清理孤立原件 */
const referencedFileIds = (session: StoredSession): string[] => {
  const ids = new Set<string>()
  for (const raw of session.messages as Record<string, unknown>[]) {
    if (raw.role !== 'user' || !Array.isArray(raw.files)) {
      continue
    }
    for (const file of raw.files as Record<string, unknown>[]) {
      if (typeof file.id === 'string') {
        ids.add(file.id)
      }
    }
  }
  return [...ids]
}

const filePath = (filesDir: string, id: string) => path.join(filesDir, id)

export const sessionRoutes = ({ db, filesDir }: Deps) => {
  const pruneUnreferenced = (keepIds: string[]): void => {
    const rows = db.prepare(`select id from files`).all() as { id: string }[]
    const keep = new Set(keepIds)
    const orphans = rows.map((row) => row.id).filter((id) => !keep.has(id))
    if (orphans.length === 0) {
      return
    }
    deleteUnreferencedFiles(db, orphans)
    for (const id of orphans) {
      void rm(filePath(filesDir, id), { force: true }).catch(() => {})
    }
  }

  return {
    listSummaries: () => listSessionSummaries(db),

  getSession: (id: string) => {
    const session = loadSession(db, id)
    if (!session) {
      throw new HttpError(404, 'session not found')
    }
    return session
  },

  putSession: async (req: Request) => {
    const session = assertSession(await readJson(req))
    // 先保存，再按本次快照被别的会话引用的并集清理孤立原件
    const keep = referencedFileIds(session)
    for (const other of listSessionSummaries(db)) {
      if (other.id === session.id) {
        continue
      }
      const stored = loadSession(db, other.id)
      if (stored) {
        keep.push(...referencedFileIds(stored as StoredSession))
      }
    }
    saveSession(db, session)
    pruneUnreferenced(keep)
    return { ok: true, fileIds: keep }
  },

  rename: async (id: string, req: Request) => {
    const body = await readJson<{ title?: unknown }>(req)
    if (typeof body.title !== 'string') {
      throw new HttpError(400, 'title must be a string')
    }
    assertCleanText(body.title, 'title')
    renameSession(db, id, body.title)
    return { ok: true }
  },

  remove: (id: string) => {
    deleteSession(db, id)
    return { ok: true }
  },

  clear: () => {
    clearSessions(db)
    return { ok: true }
  },

  /** 附件的 serverId 回填（懒上传后调用），也用于查询哪些已有 serverId */
  lookupFiles: (ids: string[]) => listFiles(db, ids),

  /** 保存原件到磁盘；同名 id 覆盖，返回记录 */
  putFile: async (id: string, name: string, req: Request): Promise<{ id: string; size: number }> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new HttpError(400, 'invalid file id')
    }
    const bytes = new Uint8Array(await req.arrayBuffer())
    await mkdir(filesDir, { recursive: true })
    await writeFile(filePath(filesDir, id), bytes)
    const mime = req.headers.get('content-type') ?? 'application/octet-stream'
    saveFile(db, {
      id,
      name,
      size: bytes.byteLength,
      mime,
      server_id: null,
      created_at: Date.now(),
    })
    return { id, size: bytes.byteLength }
  },

  getFile: (id: string): Response => {    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new HttpError(400, 'invalid file id')
    }
    const row = loadFileRow(db, id)
    const target = filePath(filesDir, id)
    if (!row || !existsSync(target)) {
      throw new HttpError(404, 'file not found')
    }
    const stream = Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>
    return new Response(stream, {
      headers: {
        'content-type': row.mime || 'application/octet-stream',
        'content-length': String(row.size),
        'cache-control': 'private, max-age=3600',
      },
    })
  },

  readFileBytes: (id: string): Promise<Buffer> => readFile(filePath(filesDir, id)),
  }
}

export type SessionRoutes = ReturnType<typeof sessionRoutes>

export { noContent }
