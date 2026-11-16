import { useState } from 'react'
import { login } from '../../services/server/http.js'
import { useTranslate } from '../../i18n/index.js'

/**
 * 服务访问密码输入。
 *
 * 服务端化之后，API Key 由服务端保管，浏览器只需要一道门的密码。
 * 密码通过 POST /api/auth 换取 HttpOnly Cookie，成功后由外层触发重新加载。
 */
export const useAccessForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failed, setFailed] = useState(false)

  const error = failed ? t('accessPasswordInvalid') : null

  const submit = async () => {
    const password = value.trim()
    if (!password || verifying) {
      return
    }
    setVerifying(true)
    setFailed(false)
    try {
      const ok = await login(password)
      if (!ok) {
        setFailed(true)
        return
      }
      setValue('')
      onSaved?.()
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
