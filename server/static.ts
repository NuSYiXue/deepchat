/**
 * 静态资源服务：把 dist/ 下的文件按请求路径返回。
 *
 * 生产构建用 contenthash 命名，因此 static/ 下的文件可以长期缓存；
 * index.html 不缓存，保证发布后能立刻拿到新的入口。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const notFound = () => new Response('Not Found', { status: 404 })

/** 规范化后的相对路径；越出 dist 目录时返回 null */
const resolveWithin = (root: string, relative: string): string | null => {
  const normalized = path
    .normalize(decodeURIComponent(relative))
    .replace(/^([/\\])+/, '')
    .replace(/^(\.\.([/\\]|$))+/, '')
  const target = path.resolve(root, normalized)
  const rel = path.relative(root, target)
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : target
}

const contentType = (filePath: string) =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'

const serveFile = (filePath: string, cacheControl: string): Response => {
  const stat = statSync(filePath)
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
  return new Response(stream, {
    headers: {
      'content-type': contentType(filePath),
      'content-length': String(stat.size),
      'cache-control': cacheControl,
    },
  })
}

/**
 * 处理静态请求。
 * 命中文件直接返回；否则回落到 index.html（单页应用）。
 * 带扩展名但文件不存在时返回 404，避免把资源请求误判成路由。
 */
export const createStaticHandler = (distDir: string) => {
  const indexPath = path.join(distDir, 'index.html')

  return (url: URL): Response => {
    if (url.pathname.startsWith('/api/')) {
      return notFound()
    }

    const target = resolveWithin(distDir, url.pathname)
    if (!target) {
      return notFound()
    }

    if (existsSync(target) && statSync(target).isFile()) {
      const isHashed = url.pathname.startsWith('/static/')
      return serveFile(target, isHashed ? 'public, max-age=31536000, immutable' : 'no-cache')
    }

    if (path.extname(url.pathname)) {
      return notFound()
    }

    if (!existsSync(indexPath)) {
      return new Response('dist/index.html not found; run pnpm build first', { status: 503 })
    }
    return serveFile(indexPath, 'no-cache')
  }
}
