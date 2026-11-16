/**
 * 入口：HTTP 服务、认证、路由分发、静态资源。
 *
 * 刻意不终止 TLS：内网直接 HTTP，公网由前置反代（NPM）转成 HTTPS。
 * 是否需要 Secure Cookie 由 X-Forwarded-Proto 判断。
 */
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'
import { createAuth, createSecret } from './auth.ts'
import { openDatabase, seedEndpoints } from './db.ts'
import { HttpError, json, sendResponse, toRequest } from './http.ts'
import { createRouter } from './router.ts'
import { createStaticHandler } from './static.ts'
import { chatRoutes } from './routes/chat.ts'
import { configRoutes } from './routes/config.ts'
import { sessionRoutes } from './routes/sessions.ts'
import { formatHits, relaySearch } from './search.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const PORT = Number(process.env.PORT ?? 3000)
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'))
const DIST_DIR = path.resolve(process.env.DIST_DIR ?? path.join(root, 'dist'))
/** 访问密码；未设置时不启用登录（仅适合本机调试） */
const PASSWORD = process.env.APP_PASSWORD ?? ''

const filesDir = path.join(DATA_DIR, 'files')
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(filesDir, { recursive: true })

const secretPath = path.join(DATA_DIR, 'secret')
if (!existsSync(secretPath)) {
  writeFileSync(secretPath, createSecret(), { mode: 0o600 })
}

const db = openDatabase(DATA_DIR)
seedEndpoints(db, {
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  apiOrigin: process.env.API_ORIGIN,
  apiModel: process.env.API_MODEL,
})
const auth = createAuth({ password: PASSWORD, secret: readFileSync(secretPath, 'utf8').trim() })
const sessions = sessionRoutes({ db, filesDir })
const chat = chatRoutes({ db })
const config = configRoutes({ db })

if (!auth.enabled) {
  process.stderr.write('[warn] APP_PASSWORD is empty; authentication is disabled\n')
}

const isHttps = (req: Request) => req.headers.get('x-forwarded-proto') === 'https'
const clientIp = (req: Request) =>
  (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown'

/** 状态变更请求要求自定义头，表单无法伪造，等于免费的 CSRF 防护 */
const requireCustomHeader = (req: Request): void => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return
  }
  if (req.headers.get('x-requested-with') !== 'XMLHttpRequest') {
    throw new HttpError(403, 'missing X-Requested-With header')
  }
}

const router = createRouter()

// ---- 认证 ----
router.post('/api/auth', async ({ req }) => {
  const body = (await req.json().catch(() => ({}))) as { password?: unknown }
  const password = typeof body.password === 'string' ? body.password : ''
  const result = auth.login(password, clientIp(req), Date.now())
  if (!result.ok) {
    return json(
      { error: result.reason === 'locked' ? 'too many attempts' : 'invalid password' },
      result.reason === 'locked' ? 429 : 401
    )
  }
  return json(
    { ok: true },
    200,
    { 'set-cookie': auth.cookieHeader(result.token, isHttps(req)) }
  )
})

router.delete('/api/auth', ({ req }) =>
  json({ ok: true }, 200, { 'set-cookie': auth.clearCookieHeader(isHttps(req)) })
)

router.get('/api/auth', ({ req }) =>
  json({ ok: auth.authenticated(req.headers.get('cookie'), Date.now()) })
)

// ---- 会话 ----
router.get('/api/sessions', () => json(sessions.listSummaries()))

router.get('/api/sessions/:id', ({ params }) => json(sessions.getSession(params.id)))

router.put('/api/sessions/:id', async ({ req }) => json(await sessions.putSession(req)))

router.patch('/api/sessions/:id', async ({ req, params }) => json(await sessions.rename(params.id, req)))

router.delete('/api/sessions/:id', ({ params }) => json(sessions.remove(params.id)))

router.delete('/api/sessions', () => json(sessions.clear()))

// ---- 附件 ----
// 静态段「lookup」必须注册在「:id」之前，否则会被当成附件 id
router.post('/api/files/lookup', async ({ req }) => {
  const body = (await req.json()) as { ids?: unknown }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string')
    : []
  return json(sessions.lookupFiles(ids))
})

router.post('/api/files/:id', async ({ req, params, url }) => {
  const name = url.searchParams.get('name') ?? params.id
  return json(await sessions.putFile(params.id, name, req))
})

router.get('/api/files/:id', ({ params }) => sessions.getFile(params.id))

// ---- LLM 代理 ----
router.post('/api/chat', async ({ req, url }) =>
  chat.proxy(req, url.searchParams.get('modelId') ?? undefined)
)

router.post('/api/upload', async ({ req, url }) =>
  json(await chat.upload(req, url.searchParams.get('modelId') ?? undefined))
)

router.post('/api/config/test-endpoint', async ({ req }) => {
  const body = (await req.json()) as { endpointId?: unknown }
  if (typeof body.endpointId !== 'string') {
    throw new HttpError(400, 'endpointId is required')
  }
  return json(await chat.verify(body.endpointId))
})

// ---- 搜索（方案 B：借用支持搜索的端点） ----
router.post('/api/search', async ({ req }) => {
  const body = (await req.json()) as { query?: unknown }
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    throw new HttpError(400, 'query is required')
  }
  const hits = await relaySearch(db, body.query, req.signal)
  return json({ hits, text: formatHits(hits) })
})

// ---- 语音 ----
router.post('/api/asr', async ({ req }) => json(await chat.transcribe(req)))
router.post('/api/tts', ({ req }) => chat.synthesize(req))

// ---- 配置 ----
router.get('/api/config', () => json(config.read()))
router.post('/api/config/endpoints', async ({ req }) => json(await config.saveEndpoint(req)))
router.post('/api/config/models', async ({ req }) => json(await config.saveModel(req)))
router.post('/api/config/personas', async ({ req }) => json(await config.savePersona(req)))
router.delete('/api/config/personas/:id', ({ params }) => json(config.deletePersona(params.id)))
router.delete('/api/config/models/:id', ({ params }) => json(config.deleteModel(params.id)))
router.post('/api/config/settings', async ({ req }) => json(await config.putSetting(req)))

const serveStatic = createStaticHandler(DIST_DIR)

/**
 * 认证只作用于 /api/：页面本身（含登录界面）必须能加载，否则未登录用户
 * 只会看到一段 JSON，无法进入应用。
 */
const handle = async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  if (!url.pathname.startsWith('/api/')) {
    return serveStatic(url)
  }
  if (url.pathname.startsWith('/api/auth')) {
    return routeApi(req, url)
  }
  if (!auth.authenticated(req.headers.get('cookie'), Date.now())) {
    return json({ error: 'unauthorized' }, 401)
  }
  requireCustomHeader(req)
  return routeApi(req, url)
}

const routeApi = async (req: Request, url: URL): Promise<Response> => {
  const matched = router.match(req.method, url)
  if (matched === 'method-not-allowed') {
    return json({ error: 'method not allowed' }, 405)
  }
  if (matched) {
    const result = await matched.handler({ req, params: matched.params, url })
    return result instanceof Response ? result : json(result)
  }
  if (url.pathname.startsWith('/api/')) {
    return json({ error: 'not found' }, 404)
  }
  return serveStatic(url)
}

const server = http.createServer((nodeReq, nodeRes: ServerResponse) => {
  void (async () => {
    const request = toRequest(nodeReq)
    try {
      const response = await handle(request)
      await sendResponse(nodeRes, response)
    } catch (error) {
      if (nodeRes.headersSent) {
        nodeRes.destroy()
        return
      }
      if (error instanceof HttpError) {
        // 上游的响应体原样透传：前端按自己的协议解析（含 error.message），
        // 再包一层字符串会让它变成无法识别的双重 JSON。
        const response =
          error.body !== undefined && error.body !== ''
            ? new Response(error.body, {
                status: error.status,
                headers: { 'content-type': 'application/json; charset=utf-8' },
              })
            : json({ error: error.message }, error.status)
        await sendResponse(nodeRes, response)
        return
      }
      process.stderr.write(`[error] ${String(error)}\n`)
      await sendResponse(nodeRes, json({ error: 'internal server error' }, 500))
    }
  })()
})

server.listen(PORT, () => {
  process.stdout.write(`listening on http://0.0.0.0:${PORT} (data: ${DATA_DIR})\n`)
})
