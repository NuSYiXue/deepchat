/**
 * 设置 → 模型：整页照 DeepSeekRuntime 的 Models 设置页移植。
 *
 * 结构与交互对齐 DSH：
 * - 每个端点一张卡片（描边 + 模块底色 + 大圆角），卡片间 8px；
 * - 头行：名称 + 自定义标签 + 凭证圆点 + 紧凑的编辑按钮；
 * - 点「编辑」在卡片内展开编辑区，不替换列表；
 * - 模型是卡片内的嵌套条目，网格排列：模型 id / 展开 / 删除 / 显示名；
 * - 模型展开后显示输入类型、容量与推理方式；
 * - API Key 输入带显示/隐藏按钮，已保存的密钥用掩码占位且禁止复制；
 * - 「添加端点」是列表末尾的整行虚线按钮。
 *
 * 相对 DSH 的删减（自用场景不需要）：
 * - DeepSeek 账号 / OAuth 登录、provider 目录与模型发现；
 * - 重试策略、图片像素预算、payload 上限、拖拽排序；
 * - provider 级 baseURL 环境变量推导。
 */
import { useState } from 'react'
import clsx from 'clsx'
import { createId } from '../../utils/id.js'
import { useTranslate } from '../../i18n/index.js'
import {
  deleteModel,
  saveEndpoint,
  saveModel,
  testEndpoint,
  useConfig,
  type Endpoint,
  type ModelConfig,
} from '../../services/server/config.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { IconChevronDownOutline14, IconTrashOutline16 } from '../base/icons.js'
import styles from './ModelSettings.module.css'

const DIALECTS = ['deepseek', 'anthropic', 'openai'] as const
const INPUT_TYPES = ['text', 'image', 'document'] as const

type EndpointDraft = {
  id: string
  name: string
  origin: string
  apiKey: string
  dialect: string
  nativeWebSearch: boolean
}

const emptyEndpoint = (): EndpointDraft => ({
  id: createId(),
  name: '',
  origin: 'https://api.deepseek.com',
  apiKey: '',
  dialect: 'deepseek',
  nativeWebSearch: false,
})

const draftFrom = (endpoint: Endpoint): EndpointDraft => ({
  id: endpoint.id,
  name: endpoint.name,
  origin: endpoint.origin,
  apiKey: '',
  dialect: endpoint.dialect,
  nativeWebSearch: endpoint.capabilities.nativeWebSearch === true,
})

const emptyModel = (endpointId: string): ModelConfig => ({
  id: createId(),
  endpointId,
  name: '',
  model: '',
  inputTypes: ['text'],
  maxContext: 64000,
  maxOutput: 8192,
  reasoning: { kind: 'none' },
  isDefault: false,
})

type Run = (action: () => Promise<void>) => Promise<void>

export const ModelSettings = () => {
  const t = useTranslate()
  const { endpoints, models } = useConfig()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newDraft, setNewDraft] = useState<EndpointDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run: Run = async (action) => {
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

  return (
    <div className={styles.section}>
      {error ? <div className={styles.noticeError}>{error}</div> : null}

      <ul className={styles.rows}>
        {endpoints.map((endpoint) => {
          const open = editingId === endpoint.id && newDraft === null
          return (
            <li key={endpoint.id} className={styles.rowCard}>
              <div className={styles.rowHead}>
                <span className={styles.rowIdentity}>
                  <span className={styles.rowName}>{endpoint.name}</span>
                  <span
                    className={clsx(
                      styles.credentialDot,
                      endpoint.hasKey ? styles.dotConfigured : styles.dotMissing
                    )}
                    role="img"
                    aria-label={
                      endpoint.hasKey ? t('settingsKeyConfigured') : t('settingsKeyMissing')
                    }
                    title={endpoint.hasKey ? t('settingsKeyConfigured') : t('settingsKeyMissing')}
                  />
                  <span className={styles.rowMeta}>{endpoint.origin}</span>
                </span>
                <span className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={busy}
                    onClick={() => {
                      setNewDraft(null)
                      setEditingId(open ? null : endpoint.id)
                    }}
                  >
                    {t('edit')}
                  </button>
                </span>
              </div>

              {open ? (
                <ProviderEditor
                  endpoint={endpoint}
                  models={models.filter((model) => model.endpointId === endpoint.id)}
                  busy={busy}
                  run={run}
                  onClose={() => setEditingId(null)}
                />
              ) : null}
            </li>
          )
        })}

        {newDraft ? (
          <li className={styles.rowCard}>
            <div className={styles.rowHead}>
              <span className={styles.rowIdentity}>
                <span className={styles.rowName}>
                  {newDraft.name.trim() || t('settingsEndpointNew')}
                </span>
                <span className={styles.rowTag}>{t('settingsTagCustom')}</span>
              </span>
            </div>
            <ProviderEditor
              draft={newDraft}
              models={[]}
              busy={busy}
              run={run}
              onChangeDraft={setNewDraft}
              onClose={() => setNewDraft(null)}
              onSaved={() => setNewDraft(null)}
            />
          </li>
        ) : null}
      </ul>

      <div className={styles.addActions}>
        <button
          type="button"
          className={styles.addButton}
          disabled={busy || newDraft !== null}
          onClick={() => {
            setEditingId(null)
            setNewDraft(emptyEndpoint())
          }}
        >
          {t('settingsAddEndpoint')}
        </button>
      </div>
    </div>
  )
}

/** 端点编辑区：连接配置 + 模型列表 */
const ProviderEditor = ({
  endpoint,
  draft: draftProp,
  models,
  busy,
  run,
  onChangeDraft,
  onClose,
  onSaved,
}: {
  endpoint?: Endpoint
  draft?: EndpointDraft
  models: ModelConfig[]
  busy: boolean
  run: Run
  onChangeDraft?: (draft: EndpointDraft) => void
  onClose: () => void
  onSaved?: () => void
}) => {
  const t = useTranslate()
  const [localDraft, setLocalDraft] = useState<EndpointDraft | null>(null)
  /** 正在编辑的模型草稿：id 在 models 里表示编辑已有，否则是新建 */
  const [modelDraft, setModelDraft] = useState<ModelConfig | null>(null)

  const draft = draftProp ?? localDraft ?? (endpoint ? draftFrom(endpoint) : null)
  const setDraft = (next: EndpointDraft) => {
    if (draftProp && onChangeDraft) {
      onChangeDraft(next)
    } else {
      setLocalDraft(next)
    }
  }

  const saveEndpointConfig = async () => {
    if (!draft) {
      return
    }
    await run(async () => {
      await saveEndpoint({
        id: draft.id,
        name: draft.name.trim() || draft.origin.trim(),
        origin: draft.origin.trim(),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        dialect: draft.dialect,
        capabilities: { nativeWebSearch: draft.nativeWebSearch },
      })
      setLocalDraft(null)
      onSaved?.()
    })
  }

  const isNew = (id: string) => !models.some((item) => item.id === id)

  return (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <span className={styles.editorTitle}>{t('settingsConnection')}</span>
        {endpoint ? <span className={styles.editorRoute}>{endpoint.dialect}</span> : null}
      </div>

      <div className={styles.fieldGrid}>
        <Field label={t('settingsEndpointName')}>
          <input
            className={styles.input}
            value={draft?.name ?? ''}
            placeholder={t('settingsEndpointNamePlaceholder')}
            onChange={(e) => draft && setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label={t('settingsEndpointOrigin')}>
          <input
            className={styles.input}
            value={draft?.origin ?? ''}
            placeholder="https://api.deepseek.com"
            spellCheck={false}
            onChange={(e) => draft && setDraft({ ...draft, origin: e.target.value })}
          />
        </Field>
        <Field label={t('settingsEndpointKey')}>
          <ApiKeyInput
            value={draft?.apiKey ?? ''}
            savedMask={endpoint?.hasKey ? (endpoint.keyHint ?? '••••') : undefined}
            placeholder={t('settingsEndpointKeyPlaceholder')}
            onChange={(value) => draft && setDraft({ ...draft, apiKey: value })}
          />
        </Field>
        <Field label={t('settingsEndpointDialect')}>
          <Select
            ariaLabel={t('settingsEndpointDialect')}
            className={styles.select}
            value={draft?.dialect ?? 'deepseek'}
            options={DIALECTS.map((dialect) => ({ value: dialect, label: dialect }))}
            onChange={(dialect) => draft && setDraft({ ...draft, dialect })}
          />
        </Field>
      </div>

      <label className={styles.checkboxItem}>
        <input
          type="checkbox"
          checked={draft?.nativeWebSearch ?? false}
          onChange={(e) => draft && setDraft({ ...draft, nativeWebSearch: e.target.checked })}
        />
        {t('settingsNativeSearch')}
      </label>

      <EditorFooter
        busy={busy}
        submitDisabled={!draft?.origin.trim() || !draft.name.trim()}
        onCancel={onClose}
        onSubmit={() => void saveEndpointConfig()}
        extra={
          endpoint ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={busy || !endpoint.hasKey}
              onClick={() =>
                void run(async () => {
                  await testEndpoint(endpoint.id)
                  showToast({ key: 'settingsTestOk' })
                })
              }
            >
              {t('settingsTest')}
            </button>
          ) : null
        }
      />

      {endpoint ? (
        <div className={styles.models}>
          <div className={styles.modelsHead}>
            <span className={styles.editorTitle}>{t('settingsModels')}</span>
            <span className={styles.editorRoute}>
              {t('settingsModelCount', { count: models.length })}
            </span>
          </div>

          {models.map((model) => {
            const expanded = modelDraft?.id === model.id && !isNew(model.id)
            return (
              <div key={model.id} className={styles.modelEntry} data-expanded={expanded ? '' : undefined}>
                <div className={styles.modelRow}>
                  <input
                    className={styles.modelIdInput}
                    value={model.model}
                    readOnly
                    aria-label={t('settingsModelUpstream')}
                    title={model.model}
                  />
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={t('settingsModelAdvanced')}
                    aria-expanded={expanded}
                    title={t('settingsModelAdvanced')}
                    onClick={() =>
                      setModelDraft((current) => (current?.id === model.id ? null : model))
                    }
                  >
                    <span className={clsx(styles.chevron, expanded && styles.chevronOpen)}>
                      <IconChevronDownOutline14 />
                    </span>
                  </button>
                  <button
                    type="button"
                    className={clsx(styles.iconButton, styles.iconButtonDanger)}
                    aria-label={`${t('delete')} ${model.model}`}
                    title={t('delete')}
                    disabled={busy || model.isDefault}
                    onClick={() => void run(() => deleteModel(model.id))}
                  >
                    <IconTrashOutline16 />
                  </button>
                  <input
                    className={styles.modelNameInput}
                    value={model.name}
                    readOnly
                    aria-label={t('settingsModelName')}
                    placeholder={t('settingsModelNamePlaceholder')}
                  />
                </div>

                {expanded && modelDraft ? (
                  <ModelFields
                    value={modelDraft}
                    busy={busy}
                    onChange={setModelDraft}
                    onCancel={() => setModelDraft(null)}
                    onSubmit={() =>
                      void run(async () => {
                        await saveModel(modelDraft)
                        setModelDraft(null)
                      })
                    }
                  />
                ) : null}
              </div>
            )
          })}

          {modelDraft && isNew(modelDraft.id) ? (
            <div className={styles.modelEntry} data-expanded="">
              <div className={styles.modelRow}>
                <span className={styles.modelIdStatic}>{t('settingsModelNew')}</span>
              </div>
              <ModelFields
                value={modelDraft}
                busy={busy}
                onChange={setModelDraft}
                onCancel={() => setModelDraft(null)}
                onSubmit={() =>
                  void run(async () => {
                    await saveModel(modelDraft)
                    setModelDraft(null)
                  })
                }
              />
            </div>
          ) : null}

          <div className={styles.addModelActions}>
            <button
              type="button"
              className={styles.addModelButton}
              disabled={busy || modelDraft !== null}
              onClick={() => setModelDraft(emptyModel(endpoint.id))}
            >
              {t('settingsAddModel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 模型完整字段：新建与展开编辑共用 */
const ModelFields = ({
  value,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: ModelConfig
  busy: boolean
  onChange: (value: ModelConfig) => void
  onCancel: () => void
  onSubmit: () => void
}) => {
  const t = useTranslate()
  const toggleInput = (type: string) => {
    const has = value.inputTypes.includes(type)
    const next = has
      ? value.inputTypes.filter((item) => item !== type)
      : [...value.inputTypes, type]
    // 至少保留一种输入类型，否则模型接收不到任何内容
    if (next.length === 0) {
      return
    }
    onChange({ ...value, inputTypes: next })
  }

  return (
    <div className={styles.modelAdvanced}>
      <Field label={t('settingsModelUpstream')}>
        <input
          className={styles.input}
          value={value.model}
          placeholder="deepseek-flash"
          spellCheck={false}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </Field>
      <Field label={t('settingsModelName')}>
        <input
          className={styles.input}
          value={value.name}
          placeholder={t('settingsModelNamePlaceholder')}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </Field>
      <Field label={t('settingsMaxContext')}>
        <input
          className={styles.input}
          type="number"
          value={value.maxContext}
          onChange={(e) => onChange({ ...value, maxContext: Number(e.target.value) })}
        />
      </Field>
      <Field label={t('settingsMaxOutput')}>
        <input
          className={styles.input}
          type="number"
          value={value.maxOutput}
          onChange={(e) => onChange({ ...value, maxOutput: Number(e.target.value) })}
        />
      </Field>

      <fieldset className={styles.modelInputTypes}>
        <legend className={styles.fieldLabel}>{t('settingsInputTypes')}</legend>
        <div className={styles.checkboxRow}>
          {INPUT_TYPES.map((type) => (
            <label key={type} className={styles.checkboxItem}>
              <input
                type="checkbox"
                checked={value.inputTypes.includes(type)}
                onChange={() => toggleInput(type)}
              />
              {type}
            </label>
          ))}
        </div>
      </fieldset>

      <Field label={t('settingsReasoning')}>
        <Select
          ariaLabel={t('settingsReasoning')}
          className={styles.select}
          value={value.reasoning.kind ?? 'none'}
          options={[
            { value: 'none', label: t('settingsReasoningNone') },
            { value: 'budget', label: t('settingsReasoningBudget') },
            { value: 'effort', label: t('settingsReasoningEffort') },
          ]}
          onChange={(kind) =>
            onChange({ ...value, reasoning: { kind: kind as 'none' | 'budget' | 'effort' } })
          }
        />
      </Field>

      <label className={styles.checkboxItem}>
        <input
          type="checkbox"
          checked={value.isDefault}
          onChange={(e) => onChange({ ...value, isDefault: e.target.checked })}
        />
        {t('settingsDefault')}
      </label>

      <EditorFooter
        busy={busy}
        submitDisabled={!value.model.trim()}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </div>
  )
}

/** API Key 输入：草稿可显示，已保存的密钥用掩码占位且禁止复制 */
const ApiKeyInput = ({
  value,
  savedMask,
  placeholder,
  onChange,
}: {
  value: string
  savedMask?: string
  placeholder: string
  onChange: (value: string) => void
}) => {
  const t = useTranslate()
  const [revealed, setRevealed] = useState(false)
  const canReveal = savedMask === undefined && value.length > 0

  return (
    <div className={styles.keyInput}>
      <input
        className={styles.input}
        type={revealed ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        placeholder={savedMask ?? placeholder}
        onCopy={(e) => {
          if (savedMask !== undefined) {
            e.preventDefault()
          }
        }}
        onCut={(e) => {
          if (savedMask !== undefined) {
            e.preventDefault()
          }
        }}
        onChange={(e) => {
          setRevealed(false)
          onChange(e.target.value)
        }}
      />
      {canReveal ? (
        <button
          type="button"
          className={styles.keyToggle}
          aria-label={revealed ? t('settingsKeyHide') : t('settingsKeyReveal')}
          aria-pressed={revealed}
          onClick={() => setRevealed((current) => !current)}
        >
          <EyeIcon off={revealed} />
        </button>
      ) : null}
    </div>
  )
}

const EYE_CONTOUR =
  'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
const EYE_PUPIL =
  'M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z'

const EyeIcon = ({ off }: { off: boolean }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.3}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d={EYE_CONTOUR} />
    {off ? <path d="M2.5 2.5L13.5 13.5" /> : <path d={EYE_PUPIL} />}
  </svg>
)

/** 底部的取消/提交行：与 DSH 一致，左取消右提交 */
const EditorFooter = ({
  busy,
  submitDisabled,
  onCancel,
  onSubmit,
  extra,
}: {
  busy: boolean
  submitDisabled: boolean
  onCancel: () => void
  onSubmit: () => void
  extra?: React.ReactNode
}) => {
  const t = useTranslate()
  return (
    <div className={styles.editorActions}>
      {extra}
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onCancel}>
        {t('cancel')}
      </button>
      <button
        type="button"
        className={styles.primaryButton}
        disabled={busy || submitDisabled}
        onClick={onSubmit}
      >
        {t('confirm')}
      </button>
    </div>
  )
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    {children}
  </label>
)
