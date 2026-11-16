/**
 * 登录态。
 *
 * 服务端用 HttpOnly Cookie 记录会话，前端拿不到也读不了，因此启动时向
 * /api/auth 问一次，把结果缓存在内存里。所有「需要权限才能继续」的入口
 * 都先看这里，未登录则把用户带到设置页的登录入口。
 */
import { create } from 'zustand'
import { checkAuth } from './http.js'

type AuthState = {
  /** null 表示尚未检查 */
  authenticated: boolean | null
}

export const useAuth = create<AuthState>(() => ({ authenticated: null }))

export const isAuthenticated = (): boolean => useAuth.getState().authenticated === true

/** 启动时调用；失败视为未登录，不阻塞界面渲染 */
export const initAuth = async (): Promise<boolean> => {
  const authenticated = await checkAuth()
  useAuth.setState({ authenticated })
  return authenticated
}

export const markAuthenticated = () => useAuth.setState({ authenticated: true })
export const markUnauthenticated = () => useAuth.setState({ authenticated: false })
