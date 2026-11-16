/**
 * 设置 → 人设：人设的增删改。
 *
 * 人设是会话级配置：新建会话时选定，之后固定。系统提示词在协议上是整条
 * messages 的前缀，中途更换会让历史消息在新人设下被重新解释，因此已有
 * 消息的会话不允许切换（聊天窗口的选择器据此置灰）。
 */
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  DEFAULT_PERSONA_ID,
  deletePersona,
  savePersona,
  useConfig,
  type Persona,
} from '../../services/server/config.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

type Draft = { id: string; name: string; prompt: string }

const emptyDraft = (): Draft => ({ id: '', name: '', prompt: '' })

const draftFrom = (persona: Persona): Draft => ({
  id: persona.id,
  name: persona.name,
  prompt: persona.prompt,
})

export const PersonaSettings = () => {
  const t = useTranslate()
  const personas = useConfig((state) => state.personas)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      showToast({ key: 'settingsSaved' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!draft) {
      return
    }
    const value = draft
    await run(async () => {
      await savePersona({ id: value.id.trim(), name: value.name.trim(), prompt: value.prompt })
      setDraft(null)
    })
  }

  return (
    <div>
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.label}>{t('settingsPersonas')}</div>
      {personas.map((persona) => (
        <div key={persona.id} className={styles.cell}>
          <div className={styles.row}>
            <div className={styles.text}>
              <div className={styles.label}>
                {persona.name}
                {persona.builtin === 1 ? ` · ${t('settingsBuiltin')}` : ''}
              </div>
              <div className={styles.description}>{persona.prompt}</div>
            </div>
            <div>
              <Button
                variant="outlined"
                size="m"
                disabled={busy || persona.builtin === 1}
                onClick={() => setDraft(draftFrom(persona))}
              >
                {t('edit')}
              </Button>{' '}
              <Button
                variant="dangerOutlined"
                size="m"
                disabled={busy || persona.builtin === 1 || persona.id === DEFAULT_PERSONA_ID}
                onClick={() => void run(() => deletePersona(persona.id))}
              >
                {t('delete')}
              </Button>
            </div>
          </div>
        </div>
      ))}

      {draft ? (
        <div className={styles.cell}>
          <div className={styles.label}>
            {draft.id ? t('settingsPersonaEdit') : t('settingsPersonaNew')}
          </div>
          <input
            className={styles.apiKeyInput}
            placeholder={t('settingsPersonaId')}
            value={draft.id}
            // 已有 id 不允许改：会话用它引用人设
            disabled={Boolean(draft.id)}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
          <input
            className={styles.apiKeyInput}
            placeholder={t('settingsPersonaName')}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <textarea
            className={styles.apiKeyInput}
            placeholder={t('settingsPersonaPrompt')}
            rows={5}
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
          <div>
            <Button variant="primary" size="m" disabled={busy} onClick={() => void submit()}>
              {t('confirm')}
            </Button>{' '}
            <Button variant="outlined" size="m" disabled={busy} onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outlined" size="m" onClick={() => setDraft(emptyDraft())}>
          {t('settingsAddPersona')}
        </Button>
      )}
    </div>
  )
}
