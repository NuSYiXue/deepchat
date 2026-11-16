/**
 * 与自建服务通信的最小 HTTP 封装。
 *
 * 所有状态变更请求都带 X-Requested-With：服务端据此拒绝跨站表单提交，
 * 等于免费的 CSRF 防护，不需要额外 token。
 */

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('X-Requested-With', 'XMLHttpRequest')
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || response.statusText
    try {
      const body: unknown = JSON.parse(text)
      if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
      ) {
        message = (body as { error: string }).error
      }
    } catch {
      // 非 JSON 响应体直接展示原文
    }
    throw new ApiError(response.status, message)
  }
  return response
}

export const getJson = async <T>(path: string): Promise<T> => (await request(path)).json() as Promise<T>

export const sendJson = async <T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<T> =>
  (
    await request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json() as Promise<T>

export const sendEmpty = async (
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<void> => {
  await request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export { request as requestRaw }

/** 登录态：无密码部署时也返回 true */
export const checkAuth = async (): Promise<boolean> => {
  try {
    const result = await getJson<{ ok?: boolean }>('/api/auth')
    return result.ok === true
  } catch {
    return false
  }
}

export const login = async (password: string): Promise<boolean> => {
  try {
    await sendJson('/api/auth', 'POST', { password })
    return true
  } catch {
    return false
  }
}

export const logout = async (): Promise<void> => {
  await sendEmpty('/api/auth', 'DELETE').catch(() => {})
}
