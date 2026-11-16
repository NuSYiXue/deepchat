/**
 * 极简路由：只用 URLPattern（Node 内置）做路径匹配，不引入框架依赖。
 *
 * 服务端刻意保持零运行时依赖：构建用 rspack，运行用 Node 内置模块
 * （node:sqlite、node:http、node:crypto），镜像里不需要原生编译工具链。
 */

export type Handler = (ctx: {
  req: Request
  params: Record<string, string>
  url: URL
}) => Response | Promise<Response>

type Route = { method: string; pattern: URLPattern; handler: Handler }

export const createRouter = () => {
  const routes: Route[] = []

  const add = (method: string, path: string, handler: Handler) => {
    routes.push({ method, pattern: new URLPattern({ pathname: path }), handler })
    return api
  }

  const api = {
    get: (path: string, handler: Handler) => add('GET', path, handler),
    post: (path: string, handler: Handler) => add('POST', path, handler),
    put: (path: string, handler: Handler) => add('PUT', path, handler),
    patch: (path: string, handler: Handler) => add('PATCH', path, handler),
    delete: (path: string, handler: Handler) => add('DELETE', path, handler),
    /** 查找匹配的路由；路径匹配但方法不对时返回 methodNotAllowed */
    match(method: string, url: URL): { handler: Handler; params: Record<string, string> } | 'method-not-allowed' | null {
      let matchedPath = false
      for (const route of routes) {
        const result = route.pattern.exec(url)
        if (!result) {
          continue
        }
        matchedPath = true
        if (route.method !== method) {
          continue
        }
        return { handler: route.handler, params: { ...result.pathname.groups } as Record<string, string> }
      }
      return matchedPath ? 'method-not-allowed' : null
    },
  }

  return api
}

export type Router = ReturnType<typeof createRouter>
