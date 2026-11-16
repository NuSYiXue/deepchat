import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { useAccessForm } from './useApiKeyForm.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/**
 * 服务访问密码。
 *
 * 服务端化后不再需要在此填写 API Key：密钥由服务端保管，浏览器只负责
 * 用访问密码换取会话 Cookie。登录成功后整页重新加载，让所有请求带上新 Cookie。
 */
export const useApiKeyEditor = () => {
  const [editing, setEditing] = useState(false)
  const form = useAccessForm(() => {
    setEditing(false)
    window.location.reload()
  })
  return { editing, setEditing, form, showInput: true }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

export const ApiKeyField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { form } = editor

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('accessPasswordStart')}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="password"
            placeholder={t('accessPasswordPlaceholder')}
            autoComplete="current-password"
            spellCheck={false}
            autoFocus={!isMobile}
            value={form.value}
            onChange={(event) => form.setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                void form.submit()
              }
            }}
          />
          {!isMobile && form.value.trim() ? (
            <>
              <span className={styles.divider} />
              <button
                type="button"
                className={styles.confirm}
                disabled={form.verifying}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void form.submit()}
              >
                {form.verifying ? t('apiKeyVerifying') : t('confirm')}
              </button>
            </>
          ) : null}
        </div>
        {form.error ? <div className={styles.error}>{form.error}</div> : null}
      </div>
    </div>
  )
}

/** 移动端：输入密码时在选项下方显示整行「确定」 */
export const ApiKeyConfirm = ({ editor: { form } }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  return form.value.trim() ? (
    <button
      type="button"
      className={styles.mobileConfirm}
      disabled={form.verifying}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void form.submit()}
    >
      {form.verifying ? t('apiKeyVerifying') : t('confirm')}
    </button>
  ) : null
}

export { IconButton }
