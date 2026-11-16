/**
 * Node http 与 Web Request/Response 之间的适配。
 *
 * 路由层只处理标准 Request/Response，入口负责两端的转换；这样流式响应
 * （SSE）可以直接从上游 body 转到下游，不经过任何缓冲。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

/** 请求体上限；附件上限 64MB，留出 multipart 编码的余量 */
export const MAX_BODY_BYTES = 72 * 1024 * 1024

/**
 * 检查字符串里是否含 Unicode 替换字符（U+FFFD）。
 *
 * 客户端若把非 UTF-8 文本（例如被按 GBK 编码的中文）当 UTF-8 发送，
 * 解码后就会得到 U+FFFD。这类数据一旦入库会永久显示为乱码，且无法自动还原，
 * 所以在写入前直接拒绝，让调用方看到明确错误。
 */
export const hasReplacementChar = (value: string): boolean => value.includes('\uFFFD')

/** 校验用户可见文本；含替换字符时抛 400 */
export const assertCleanText = (value: string, field: string): void => {
  if (hasReplacementChar(value)) {
    throw new HttpError(400, `${field} contains invalid UTF-8 (U+FFFD); check the client encoding`)
  }
}

const aborted = Symbol('aborted')

/** 把 IncomingMessage 转成 Web Request；客户端断开时中止请求信号 */
export const toRequest = (req: IncomingMessage): Request => {
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  const host = req.headers.host ?? 'localhost'
  const url = new URL(req.url ?? '/', `${protocol}://${host}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(key, item)
    }
  }

  const init: RequestInit & { duplex?: 'half' } = { method: req.method ?? 'GET', headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 用 duplex: 'half' 把 Node 可读流转成请求体，避免整块读入内存
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
    init.duplex = 'half'
  }
  const request = new Request(url, init)
  req.on('aborted', () => {
    // 由调用方通过 signal 感知；Request 没有可中止的入口，这里只做标记
    ;(request as Request & { [aborted]?: boolean })[aborted] = true
  })
  return request
}

/** 把 Web Response 写回 Node 响应；有 body 时按块透传 */
export const sendResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  res.statusCode = response.status
  for (const [key, value] of response.headers) {
    // set-cookie 可能有多条，append 才能保留全部
    if (key.toLowerCase() === 'set-cookie') {
      const existing = res.getHeader('set-cookie')
      const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : []
      res.setHeader('set-cookie', [...list, value])
    } else {
      res.setHeader(key, value)
    }
  }
  if (!response.body) {
    res.end()
    return
  }
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('error', () => res.destroy())
  res.on('close', () => body.destroy())
  body.pipe(res)
}

export class HttpError extends Error {
  readonly status: number
  /** 上游返回的原始响应体；有值时原样透传，避免把上游 JSON 再包一层字符串 */
  readonly body: string | undefined

  constructor(status: number, message: string, body?: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

export const json = (value: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

export const noContent = (headers?: HeadersInit): Response => new Response(null, { status: 204, headers })

/** 读取并校验 JSON 请求体；超过上限时抛 413 */
export const readJson = async <T>(req: Request): Promise<T> => {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'request body too large')
  }
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'request body too large')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}
