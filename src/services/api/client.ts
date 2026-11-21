import { translate, type TranslationMessage } from '../../i18n/index.js'
import { resizeUploadImage } from '../../utils/resizeUploadImage.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/**
 * 前端不再直接访问上游 API，全部经自建服务转发：
 * - API Key 不进入前端产物；
 * - 浏览器与上游之间没有 CORS 约束；
 * - 陌生端点的私有字段可以在服务端裁剪。
 */
const CHAT_ENDPOINT = '/api/chat'
const UPLOAD_ENDPOINT = '/api/upload'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      // 会话 Cookie 是同源 HttpOnly，必须带上
      credentials: 'same-origin',
      headers: {
        // 服务端用它拒绝跨站表单提交
        'X-Requested-With': 'XMLHttpRequest',
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/**
 * 上传附件到上游 Files API，经自建服务转发。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal,
  modelId?: string
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  // 图片在客户端按长边上限缩放后再上传（服务端原样转发，不做尺寸处理）。
  form.append('file', purpose === null ? await resizeUploadImage(file, signal) : file)
  const query = modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''
  const response = await request(`${UPLOAD_ENDPOINT}${query}`, {
    method: 'POST',
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** 删除上游文件；服务端可能不支持，调用方自行忽略失败 */
export const deleteFile = async (fileId: string): Promise<void> => {
  await request(`/api/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
}

/**
 * POST /api/chat（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * 服务端把上游 SSE 原样回吐，因此解析逻辑与直连时一致。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  body: CreateMessageRequest,
  signal: AbortSignal,
  modelId?: string
): AsyncGenerator<MessageStreamEvent> {
  const query = modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''
  const response = await request(`${CHAT_ENDPOINT}${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
