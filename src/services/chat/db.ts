/**
 * 会话存储：服务端 API 实现。
 *
 * 与旧的 IndexedDB 版本保持完全相同的函数签名，store.ts / history 模块
 * 不需要改动。服务端是唯一写者，因此保存仍是「整会话覆盖」。
 *
 * 历史导入的暂存区（staging）仍然留在本地 IndexedDB：它是导入过程中的
 * 临时校验区，本身不是持久数据，放服务端反而需要额外的清理协议。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { getJson, sendEmpty, sendJson } from '../server/http.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** 暂存区结构版本；与正式数据解耦，改动不影响服务端存储 */
const STAGING_VERSION = 1

export type StoredFile = {
  id: string
  blob: Blob
}

type StagedFile = { id: string; blob: Blob }

interface StagingDB extends DBSchema {
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StagedFile }
}

let dbPromise: Promise<IDBPDatabase<StagingDB>> | null = null

const getDB = () =>
  (dbPromise ??= openDB<StagingDB>('chat-demo-staging', STAGING_VERSION, {
    upgrade(db) {
      for (const name of ['sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
    },
  }).catch((error: unknown) => {
    dbPromise = null
    throw error
  }))

/** 附件接口返回的元数据；serverId 为空表示还没上传到上游 */
export type FileMeta = {
  id: string
  name: string
  size: number
  mime: string
  server_id: string | null
  created_at: number
}

// ---------- 正式存储：全部走服务端 ----------

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await getJson<SessionSummary[]>('/api/sessions')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> => {
  try {
    return await getJson<Session>(`/api/sessions/${encodeURIComponent(id)}`)
  } catch (error) {
    // 404 对应旧实现里 get 返回 undefined 的语义
    if (error instanceof Error && 'status' in error && (error as { status: number }).status === 404) {
      return undefined
    }
    throw error
  }
}

/**
 * 落盘前剥掉附件的内存原件。blob 只用于本次发送时的内联编码，序列化成
 * JSON 只会得到 `{}`，白白增加请求体积。
 */
const withoutBlobs = (session: Session): Session => ({
  ...session,
  messages: session.messages.map((message) =>
    message.role === 'user' && message.files.some((file) => file.blob !== undefined)
      ? {
          ...message,
          files: message.files.map((file) => {
            const { blob, ...rest } = file
            void blob
            return rest
          }),
        }
      : message
  ),
})

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  // 原件先落盘，再提交会话快照，避免会话引用了还不存在的文件
  for (const file of files) {
    await uploadFile(file)
  }
  await sendJson(`/api/sessions/${encodeURIComponent(session.id)}`, 'PUT', withoutBlobs(session))
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  await sendJson(`/api/sessions/${encodeURIComponent(id)}`, 'PATCH', { title })
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  await sendEmpty(`/api/sessions/${encodeURIComponent(sessionId)}`, 'DELETE')
}

/** 清空全部会话；服务端不删除附件原件，由会话引用关系决定留存 */
export const clearAllSessions = async (): Promise<void> => {
  await sendEmpty('/api/sessions', 'DELETE')
}

// ---------- 附件 ----------

const uploadFile = async ({ id, blob }: StoredFile): Promise<void> => {
  const name = blob instanceof File ? blob.name : id
  const response = await fetch(
    `/api/files/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'content-type': blob.type || 'application/octet-stream',
      },
      body: blob,
      credentials: 'same-origin',
    }
  )
  if (!response.ok) {
    throw new Error(`upload failed: ${response.status}`)
  }
}

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    await uploadFile(file)
  }
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    credentials: 'same-origin',
  })
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`download failed: ${response.status}`)
  }
  return response.blob()
}

/** 查询附件的上游 serverId，用于判断哪些还需要懒上传 */
export const lookupFiles = async (ids: string[]): Promise<FileMeta[]> => {
  if (ids.length === 0) {
    return []
  }
  return sendJson<FileMeta[]>('/api/files/lookup', 'POST', { ids })
}

// ---------- 历史导入暂存区：保留在本地 ----------

export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

const putStagingFiles = async (files: StoredFile[]) => {
  const tx = (await getDB()).transaction('filesStaging', 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> => putStagingFiles(files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后提交：清空服务端旧数据，再写入暂存区的会话与原件。
 *
 * 与原版 IndexedDB 实现的 `commitStaging` 语义一致——导入是「替换」而不是
 * 「合并」，否则旧会话会残留在列表里。清空放在最前，因为后续任一步失败时
 * 调用方会清空暂存并报错，让用户重试，不会留下半套数据。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const db = await getDB()
  const files = await db.getAll('filesStaging')
  const sessions = await db.getAll('sessionsStaging')

  // 先清空：服务端会同时删除全部会话与消息；附件原件由会话引用关系驱动清理
  await clearAllSessions()
  await saveFiles(files)

  const summaries: SessionSummary[] = []
  for (const session of sessions) {
    await sendJson(`/api/sessions/${encodeURIComponent(session.id)}`, 'PUT', session)
    summaries.push(toSessionSummary(session))
  }
  await clearStaging()
  return summaries
}

/** 存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
