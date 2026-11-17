/**
 * 开发模式：同时启动 Node 后端与 rspack dev server。
 *
 * 前端只请求同源的 `/api/*`，这些接口由 server/index.ts 提供，dev server 通过
 * proxy 转发过去。所以两者必须一起跑：只启动 dev server 时页面能打开，但登录、
 * 会话、模型配置等所有请求都会 404。
 *
 * 不引入 concurrently 之类的依赖，直接用 node 的 spawn 管理两个子进程，
 * Ctrl+C 时一起退出。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 直接跑本地 rspack 的入口，避免经 npx 再解析一次（Windows 下还要 shell） */
const rspackBin = path.join(root, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js')

const backend = spawn(process.execPath, [path.join(root, 'server', 'index.ts')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT ?? '3000' },
})

const devServer = spawn(process.execPath, [rspackBin, 'serve', '-c', 'rspack.config.ts'], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' },
})

/** 任一子进程退出就整体退出，避免留下孤儿进程占端口 */
let closing = false
const shutdown = (code) => {
  if (closing) {
    return
  }
  closing = true
  for (const child of [backend, devServer]) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
    }
  }
  process.exit(code)
}

backend.on('exit', (code, signal) => {
  if (!closing) {
    process.stderr.write(`[dev] backend exited (${signal ?? code})\n`)
    shutdown(code ?? 1)
  }
})
devServer.on('exit', (code, signal) => {
  if (!closing) {
    process.stderr.write(`[dev] rspack dev server exited (${signal ?? code})\n`)
    shutdown(code ?? 1)
  }
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
