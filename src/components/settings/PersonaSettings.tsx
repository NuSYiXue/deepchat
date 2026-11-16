/**
 * 设置 → 人设：人设的增删改。
 *
 * 人设是会话级配置：新建会话时选定，之后固定。系统提示词在协议上是整条
 * messages 的前缀，中途更换会让历史消息在新人设下被重新解释，因此已有
 * 消息的会话不允许切换（聊天窗口的选择器据此置灰）。
 *
 * id 由客户端自动生成，不让用户填：它只是会话引用人设的内部键，对用户
 * 没有意义，暴露出来反而增加「填什么」的负担。
 */
import clsx from 'clsx'
import { useState } from 'react'
import { createId } from '../../utils/id.js'
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

const emptyDraft = (): Draft => ({ id: createId(), name: '', prompt: '' })

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
      await savePersona({ id: value.id, name: value.name.trim(), prompt: value.prompt })
      setDraft(null)
    })
  }

  return (
    <div>
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.groupTitle}>{t('settingsPersonas')}</div>
      {personas.map((persona) => (
        <div key={persona.id} className={styles.cell}>
          <div className={styles.row}>
            <div className={clsx(styles.text, styles.textDense)}>
              <div className={styles.label}>
                {persona.name}
                {persona.builtin === 1 ? ` · ${t('settingsBuiltin')}` : ''}
              </div>
              <div className={styles.description}>{persona.prompt}</div>
            </div>
            <div className={styles.cellActions}>
              <Button
                variant="outlined"
                size="m"
                disabled={busy || persona.builtin === 1}
                onClick={() => setDraft(draftFrom(persona))}
              >
                {t('edit')}
              </Button>
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
        <div className={styles.formSection}>
          <div className={styles.formTitle}>
            {draft.id && personas.some((item) => item.id === draft.id)
              ? t('settingsPersonaEdit')
              : t('settingsPersonaNew')}
          </div>
          <div className={styles.field}>
            <div className={styles.fieldLabel}>{t('settingsPersonaName')}</div>
            <input
              className={styles.fieldInput}
              value={draft.name}
              placeholder={t('settingsPersonaNamePlaceholder')}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <div className={styles.fieldLabel}>{t('settingsPersonaPrompt')}</div>
            <textarea
              className={styles.fieldInput}
              rows={5}
              value={draft.prompt}
              placeholder={t('settingsPersonaPromptPlaceholder')}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </div>
          <div className={styles.formActions}>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="m"
              disabled={busy || draft.name.trim() === '' || draft.prompt.trim() === ''}
              onClick={() => void submit()}
            >
              {t('confirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.cell}>
          <Button variant="outlined" size="m" onClick={() => setDraft(emptyDraft())}>
            {t('settingsAddPersona')}
          </Button>
        </div>
      )}
    </div>
  )
}
