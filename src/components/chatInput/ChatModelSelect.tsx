/**
 * 聊天输入框里的模型与人设选择器。
 *
 * 两者都是会话级设置。新对话（sessionId 为 null）时选择先记在
 * usePendingSelection 里，等首条消息创建会话时再落到 Session 上，
 * 这样用户可以在输入前就选好模型与人设。
 */
import { useMemo } from 'react'
import { useConfig, DEFAULT_PERSONA_ID, resolveModel } from '../../services/server/config.js'
import {
  setPendingModel,
  setPendingPersona,
  usePendingSelection,
} from '../../services/chat/drafts.js'
import { setSessionModel, setSessionPersona, useChatStore } from '../../services/chat/store.js'
import { useTranslate } from '../../i18n/index.js'
import { Select, type SelectOption } from '../base/Select.js'
import styles from './ChatInput.module.css'

/** 模型选择：不限制会话是否已有消息，每条回复都会记录当时的模型快照 */
export const ChatModelSelect = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const models = useConfig((state) => state.models)
  const endpoints = useConfig((state) => state.endpoints)
  const pending = usePendingSelection((state) => state.modelId)
  const session = useChatStore((state) =>
    sessionId !== null ? state.sessionCache[sessionId] : undefined
  )

  /**
   * 内置端点的模型不做单独选择：它的模型由程序固定，与原版一致，
   * 下拉里直接显示为「DeepSeek 官方」。自定义端点的模型按名称列出。
   */
  const options = useMemo<SelectOption<string>[]>(() => {
    const builtinEndpointIds = new Set(
      endpoints.filter((endpoint) => endpoint.builtin).map((endpoint) => endpoint.id)
    )
    // 关闭的模型不出现在这里
    return models
      .filter((model) => model.enabled)
      .map((model) =>
        builtinEndpointIds.has(model.endpointId)
          ? { value: model.id, label: t('settingsBuiltinDeepSeek') }
          : { value: model.id, label: model.name || model.model }
      )
  }, [models, endpoints, t])
  // 新对话用待创建的选择，已有会话看会话自身
  const current =
    sessionId === null
      ? (resolveModel(pending)?.id ?? '')
      : (resolveModel(session?.modelId)?.id ?? '')

  if (models.length === 0) {
    return null
  }
  return (
    <Select
      value={current}
      options={options}
      ariaLabel={t('selectModel')}
      placeholder={t('selectModel')}
      className={styles.select}
      onChange={(value) => {
        if (sessionId === null) {
          setPendingModel(value)
        } else {
          setSessionModel(sessionId, value)
        }
      }}
    />
  )
}

/**
 * 人设选择：仅空会话可切换。
 *
 * system 是整条 messages 的前缀，中途换人设会让历史在新人设下被重新解读，
 * 协议上没有按轮次分段的手段，所以非空会话直接禁用并给出说明。
 * 新对话（尚无会话）不受限，选择先记在 pending 里。
 */
export const ChatPersonaSelect = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const personas = useConfig((state) => state.personas)
  const pending = usePendingSelection((state) => state.personaId)
  const session = useChatStore((state) =>
    sessionId !== null ? state.sessionCache[sessionId] : undefined
  )

  const options = useMemo<SelectOption<string>[]>(
    () => personas.map((persona) => ({ value: persona.id, label: persona.name })),
    [personas]
  )
  const current =
    sessionId === null
      ? (pending ?? DEFAULT_PERSONA_ID)
      : (session?.personaId ?? DEFAULT_PERSONA_ID)
  const locked = sessionId !== null && (session?.messages.length ?? 0) > 0

  if (personas.length === 0) {
    return null
  }
  return (
    <Select
      value={current}
      options={options}
      ariaLabel={t('selectPersona')}
      placeholder={t('selectPersona')}
      disabled={locked}
      className={styles.select}
      onChange={(value) => {
        if (sessionId === null) {
          setPendingPersona(value)
        } else {
          setSessionPersona(sessionId, value)
        }
      }}
    />
  )
}
