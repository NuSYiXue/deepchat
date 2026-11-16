import { create } from 'zustand'
import { isAuthenticated } from '../../services/server/authState.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/** 设置弹窗：侧边栏底部、未登录时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 需要权限的操作入口：已登录直接放行，未登录则打开设置并选中登录所在的「数据管理」。
 *
 * 服务端化之后不再需要用户填写 API Key：密钥保存在服务端，浏览器只需要访问密码。
 */
export const ensureApiKey = () => {
  if (isAuthenticated()) {
    return true
  }
  openSettings('data')
  return false
}
