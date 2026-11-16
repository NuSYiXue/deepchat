/**
 * 访问控制：单密码 + 签名 Cookie。
 *
 * 没有用户表——只有一道门。Cookie 值为「过期时间.HMAC(过期时间)」，
 * 服务端用 SECRET 验签，不需要 Session 存储。
 *
 * 关键点：Secure 标记按实际协议决定。内网直连是 HTTP，若强行加 Secure，
 * 浏览器会直接丢弃 Cookie，表现为「登录成功却立刻跳回登录页」。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'chat_demo_session'
/** 登录有效期 30 天 */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60
/** 失败锁定：15 分钟内累计 5 次失败即拒绝 */
const MAX_FAILURES = 5
const LOCKOUT_MS = 15 * 60 * 1000

export type AuthConfig = {
  /** 访问密码；为空表示不启用登录（仅限本机调试） */
  password: string
  /** HMAC 密钥，首次启动生成并持久化 */
  secret: string
}

const sign = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url')

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    return false
  }
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right))
}

export const createAuth = (config: AuthConfig) => {
  const enabled = config.password.length > 0
  /** 按来源 IP 记录失败次数与锁定截止时间 */
  const failures = new Map<string, { count: number; until: number }>()

  const isLocked = (ip: string, now: number): boolean => {
    const record = failures.get(ip)
    if (!record) {
      return false
    }
    if (record.until > now) {
      return true
    }
    if (record.until !== 0 && record.until <= now) {
      failures.delete(ip)
    }
    return false
  }

  const recordFailure = (ip: string, now: number): void => {
    const record = failures.get(ip) ?? { count: 0, until: 0 }
    record.count += 1
    if (record.count >= MAX_FAILURES) {
      record.until = now + LOCKOUT_MS
      record.count = 0
    }
    failures.set(ip, record)
  }

  const issueToken = (now: number): string => {
    const expires = String(now + MAX_AGE_SECONDS * 1000)
    return `${expires}.${sign(config.secret, expires)}`
  }

  const verifyToken = (token: string, now: number): boolean => {
    const [expires, signature] = token.split('.')
    if (!expires || !signature) {
      return false
    }
    const expiry = Number(expires)
    if (!Number.isSafeInteger(expiry) || expiry <= now) {
      return false
    }
    return safeEqual(signature, sign(config.secret, expires))
  }

  const readCookie = (header: string | null): string | null => {
    if (!header) {
      return null
    }
    for (const part of header.split(';')) {
      const index = part.indexOf('=')
      if (index === -1) {
        continue
      }
      if (part.slice(0, index).trim() === COOKIE_NAME) {
        return part.slice(index + 1).trim()
      }
    }
    return null
  }

  /**
   * 生成 Set-Cookie。isHttps 由调用方根据 X-Forwarded-Proto 决定：
   * 经 NPM 的公网请求是 https，内网直连是 http。
   */
  const cookieHeader = (token: string, isHttps: boolean): string =>
    [
      `${COOKIE_NAME}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${MAX_AGE_SECONDS}`,
      isHttps ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ')

  const clearCookieHeader = (isHttps: boolean): string =>
    [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0', isHttps ? 'Secure' : '']
      .filter(Boolean)
      .join('; ')

  return {
    enabled,
    /** 校验密码并返回新的 Cookie 值；失败返回 null */
    login(password: string, ip: string, now: number):
      | { ok: true; token: string }
      | { ok: false; reason: 'locked' | 'invalid' } {
      if (!enabled) {
        return { ok: true, token: issueToken(now) }
      }
      if (isLocked(ip, now)) {
        return { ok: false, reason: 'locked' }
      }
      if (!safeEqual(password, config.password)) {
        recordFailure(ip, now)
        return { ok: false, reason: 'invalid' }
      }
      failures.delete(ip)
      return { ok: true, token: issueToken(now) }
    },
    /** 请求是否已通过认证 */
    authenticated(cookieHeaderValue: string | null, now: number): boolean {
      if (!enabled) {
        return true
      }
      const token = readCookie(cookieHeaderValue)
      return token !== null && verifyToken(token, now)
    },
    cookieHeader,
    clearCookieHeader,
  }
}

export type Auth = ReturnType<typeof createAuth>

/** 首次启动生成随机密钥；调用方负责持久化到 data/secret */
export const createSecret = (): string => randomBytes(32).toString('base64url')
