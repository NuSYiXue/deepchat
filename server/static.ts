/**
 * 静态资源服务：把 dist/ 下的文件按请求路径返回。
 *
 * 生产构建用 contenthash 命名，因此 static/ 下的文件可以长期缓存；
 * index.html 不缓存，保证发布后能立刻拿到新的入口。
 *
 * 文本类资源按 Accept-Encoding 做 br / gzip 压缩。构建产物是 contenthash
 * 命名的，内容永不变，所以压缩结果直接缓存在内存里，重复请求不再压一遍。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { brotliCompress, gzip } from 'node:zlib'
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

/** 值得压缩的类型；图片与字体本身已是压缩格式，再压只会更慢 */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map'])
/** 小于这个体积压缩收益抵不上开销 */
const MIN_COMPRESS_BYTES = 1024

type Encoding = 'br' | 'gzip'

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

/** Accept-Encoding 里是否接受某个编码，遵守 q=0 表示明确拒绝 */
const accepts = (header: string | null, coding: string): boolean => {
  if (!header) {
    return false
  }
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (name !== coding) {
      continue
    }
    const q = params.map((item) => item.trim()).find((item) => item.startsWith('q='))
    if (!q) {
      return true
    }
    const value = Number(q.slice(2))
    return !Number.isFinite(value) || value > 0
  }
  return false
}

/** 优先 brotli：同等体积下比 gzip 小约 15% */
const negotiate = (header: string | null): Encoding | null => {
  if (accepts(header, 'br')) {
    return 'br'
  }
  return accepts(header, 'gzip') ? 'gzip' : null
}

/** 压缩结果缓存：键含编码，因为同一文件两种编码的产物不同 */
const compressedCache = new Map<string, Uint8Array<ArrayBuffer>>()
const pendingCompression = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()

const compressFile = (filePath: string, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> => {
  const key = `${encoding}:${filePath}`
  const cached = compressedCache.get(key)
  if (cached) {
    return Promise.resolve(cached)
  }
  const running = pendingCompression.get(key)
  if (running) {
    return running
  }
  const task = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    // 拷进独立的 ArrayBuffer：readFileSync 返回的 Buffer 是内存池视图，
    // 直接交给 zlib 会让类型上出现 ArrayBufferLike 与 ArrayBuffer 的分歧
    const source = new Uint8Array(readFileSync(filePath))
    const run = encoding === 'br' ? brotliCompress : gzip
    run(source, (error, result) => {
      if (error) {
        reject(error)
        return
      }
      const bytes = new Uint8Array(result)
      compressedCache.set(key, bytes)
      resolve(bytes)
    })
  }).finally(() => pendingCompression.delete(key))
  pendingCompression.set(key, task)
  return task
}

const serveFile = async (
  filePath: string,
  cacheControl: string,
  encoding: Encoding | null
): Promise<Response> => {
  const stat = statSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  if (encoding && COMPRESSIBLE.has(ext) && stat.size >= MIN_COMPRESS_BYTES) {
    const body = await compressFile(filePath, encoding)
    return new Response(body, {
      headers: {
        'content-type': contentType(filePath),
        'content-length': String(body.byteLength),
        'cache-control': cacheControl,
        'content-encoding': encoding,
        // 同一 URL 因 Accept-Encoding 有不同表示，缓存必须按编码区分
        vary: 'accept-encoding',
      },
    })
  }
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
  return new Response(stream, {
    headers: {
      'content-type': contentType(filePath),
      'content-length': String(stat.size),
      'cache-control': cacheControl,
      vary: 'accept-encoding',
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

  return async (url: URL, req: Request): Promise<Response> => {
    if (url.pathname.startsWith('/api/')) {
      return notFound()
    }

    const target = resolveWithin(distDir, url.pathname)
    if (!target) {
      return notFound()
    }

    const encoding = negotiate(req.headers.get('accept-encoding'))

    if (existsSync(target) && statSync(target).isFile()) {
      const isHashed = url.pathname.startsWith('/static/')
      return serveFile(
        target,
        isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        encoding
      )
    }

    if (path.extname(url.pathname)) {
      return notFound()
    }

    if (!existsSync(indexPath)) {
      return new Response('dist/index.html not found; run pnpm build first', { status: 503 })
    }
    return serveFile(indexPath, 'no-cache', encoding)
  }
}
