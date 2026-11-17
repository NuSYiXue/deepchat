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
  deleteEndpoint,
  deleteModel,
  listEndpointModels,
  saveEndpoint,
  saveModel,
  testEndpoint,
  useConfig,
  type Endpoint,
  REASONING_LEVELS,
  type ModelConfig,
} from '../../services/server/config.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { IconChevronDownOutline14, IconTrashOutline16 } from '../base/icons.js'
import styles from './ModelSettings.module.css'

const DIALECTS = ['deepseek', 'anthropic', 'openai'] as const
const INPUT_TYPES = ['text', 'image', 'document'] as const

/** 输入类型对应的文案 key */
const INPUT_TYPE_LABELS = {
  text: 'settingsInputTypeText',
  image: 'settingsInputTypeImage',
  document: 'settingsInputTypeDocument',
} as const

type EndpointDraft = {
  id: string
  name: string
  origin: string
  apiKey: string
  dialect: string
}

const emptyEndpoint = (): EndpointDraft => ({
  id: createId(),
  name: '',
  origin: 'https://api.deepseek.com',
  apiKey: '',
  dialect: 'deepseek',
})

const draftFrom = (endpoint: Endpoint): EndpointDraft => ({
  id: endpoint.id,
  name: endpoint.name,
  origin: endpoint.origin,
  apiKey: '',
  dialect: endpoint.dialect,
})

const emptyModel = (endpointId: string): ModelConfig => ({
  id: createId(),
  endpointId,
  name: '',
  model: '',
  inputTypes: ['text'],
  maxContext: 64000,
  maxOutput: 8192,
  // 空字典表示未开启推理等级
  reasoning: {},
  isDefault: false,
  nativeSearch: false,
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
                  {endpoint.builtin ? (
                    <span className={styles.rowTag}>{t('settingsTagBuiltin')}</span>
                  ) : null}
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
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={busy || endpoint.builtin}
                    title={endpoint.builtin ? t('settingsBuiltinCannotDelete') : undefined}
                    onClick={() => void run(() => deleteEndpoint(endpoint.id))}
                  >
                    {t('delete')}
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
      })
      setLocalDraft(null)
      onSaved?.()
    })
  }

  const isNew = (id: string) => !models.some((item) => item.id === id)

  /**
   * 内置端点完全沿用项目原本的配置。
   *
   * 和原版一致：这里只有 API Key 一项，名称、地址、方言、搜索能力都不出现——
   * 它们由程序固定，一旦被改坏，深度思考回落、语音、附件上传等依赖官方能力的
   * 路径都会失效。
   */
  const builtin = endpoint?.builtin === true

  return (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <span className={styles.editorTitle}>{t('settingsConnection')}</span>
        {endpoint && !builtin ? (
          <span className={styles.editorRoute}>{endpoint.dialect}</span>
        ) : null}
      </div>

      {builtin ? (
        <Field label={t('settingsEndpointKey')}>
          <ApiKeyInput
            value={draft?.apiKey ?? ''}
            savedMask={endpoint?.hasKey ? (endpoint.keyHint ?? '••••') : undefined}
            placeholder={t('settingsEndpointKeyPlaceholder')}
            onChange={(value) => draft && setDraft({ ...draft, apiKey: value })}
          />
        </Field>
      ) : (
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
      )}

      <EditorFooter
        busy={busy}
        submitDisabled={builtin ? false : !draft?.origin.trim() || !draft.name.trim()}
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

      {/* 内置端点的模型由程序固定，不展示列表；聊天窗口的选择器里直接
          显示为「DeepSeek 官方」。这里只在自定义端点下渲染模型管理。 */}
      {endpoint && !builtin ? (
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
              <div
                key={model.id}
                className={styles.modelEntry}
                data-expanded={expanded ? '' : undefined}
              >
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
                    builtin={false}
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
                builtin={false}
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
  builtin,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: ModelConfig
  /** 内置端点下的模型不提供推理等级：项目原本没有这个概念 */
  builtin: boolean
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
        <div className={styles.upstreamRow}>
          <input
            className={styles.input}
            value={value.model}
            placeholder="deepseek-flash"
            spellCheck={false}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
          <ModelPicker endpointId={value.endpointId} onPick={(id) => onChange({ ...value, model: id })} />
        </div>
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
              {t(INPUT_TYPE_LABELS[type])}
            </label>
          ))}
        </div>
      </fieldset>

      {builtin ? null : <ReasoningEditor value={value} onChange={onChange} />}

      {/* 原生联网搜索是模型能力：不同模型的工具支持并不相同 */}
      {builtin ? null : (
        <label className={styles.checkboxItem}>
          <input
            type="checkbox"
            checked={value.nativeSearch}
            onChange={(e) => onChange({ ...value, nativeSearch: e.target.checked })}
          />
          {t('settingsNativeSearch')}
        </label>
      )}

      {/* 默认模型是全局唯一的：用一个明确的按钮表达，而不是一个可勾选的框 */}
      <div className={styles.defaultRow}>
        {value.isDefault ? (
          <span className={styles.defaultBadge}>{t('settingsIsDefaultModel')}</span>
        ) : (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => onChange({ ...value, isDefault: true })}
          >
            {t('settingsSetDefaultModel')}
          </button>
        )}
        <span className={styles.reasoningHint}>{t('settingsDefaultModelHint')}</span>
      </div>

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

/** 推理等级打开时使用的默认档位 */
const DEFAULT_LEVEL = 'medium'

/** 可选档位（不含 off：关掉开关就是关闭推理） */
const THINKING_LEVELS = REASONING_LEVELS.filter((level) => level !== 'off')

/**
 * 推理等级：开关 + 一个档位下拉。
 *
 * 与 DeepSeekRuntime 的 reasoningEfforts 语义一致，但简化为单档位：这里配的是
 * 「该模型允许的推理强度」，聊天窗口的「深度思考」只有在这里开启时才可用。
 * 关闭开关等价于声明该模型不推理，此时主页的深度思考按钮置灰。
 *
 * 存储仍是「档位 → API 参数值」字典，只保留一项且值等于档位名。
 */
const ReasoningEditor = ({
  value,
  onChange,
}: {
  value: ModelConfig
  onChange: (value: ModelConfig) => void
}) => {
  const t = useTranslate()
  const entries = Object.entries(value.reasoning ?? {})
  const enabled = entries.length > 0
  /** 当前生效的档位：字典里唯一的键 */
  const current = entries[0]?.[0] ?? DEFAULT_LEVEL

  const setEnabled = (on: boolean) => {
    onChange({ ...value, reasoning: on ? { [DEFAULT_LEVEL]: DEFAULT_LEVEL } : {} })
  }
  const setLevel = (level: string) => {
    onChange({ ...value, reasoning: { [level]: level } })
  }

  return (
    <div className={styles.reasoning}>
      <div className={styles.reasoningHead}>
        <span className={styles.fieldLabel}>{t('settingsReasoning')}</span>
        <button
          type='button'
          role='switch'
          aria-checked={enabled}
          aria-label={t('settingsReasoning')}
          className={clsx(styles.switch, enabled && styles.switchOn)}
          onClick={() => setEnabled(!enabled)}
        >
          <span className={styles.switchKnob} />
        </button>
      </div>

      {enabled ? (
        <>
          {/* 用项目的 Select 而不是原生 select：原生下拉菜单由浏览器绘制，
              深色主题下会出现白底浅字的不可读状态 */}
          <Select
            ariaLabel={t('settingsReasoningLevel')}
            className={styles.levelSelect}
            value={current}
            options={THINKING_LEVELS.map((level) => ({ value: level, label: level }))}
            onChange={setLevel}
          />
          <p className={styles.reasoningHint}>{t('settingsReasoningHint')}</p>
        </>
      ) : (
        <p className={styles.reasoningHint}>{t('settingsReasoningOffHint')}</p>
      )}
    </div>
  )
}

/**
 * 「获取可用模型」：向端点查询模型列表并让用户挑一个。
 *
 * 查询走 `/api/config/models/list`，用已保存的端点配置与密钥；拿不到时
 * 保留手动输入，不阻塞流程。
 */
const ModelPicker = ({
  endpointId,
  onPick,
}: {
  endpointId: string
  onPick: (id: string) => void
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<{ id: string; name: string | null }[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      const list = await listEndpointModels(endpointId)
      setModels(list)
      setOpen(true)
      if (list.length === 0) {
        setError(t('settingsFetchModelsEmpty'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setModels(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.pickerWrap}>
      <button
        type="button"
        className={styles.secondaryButton}
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? t('settingsFetchingModels') : t('settingsFetchModels')}
      </button>

      {open && models ? (
        <div className={styles.pickerPanel}>
          <div className={styles.pickerHead}>
            <span className={styles.fieldLabel}>{t('settingsAvailableModels')}</span>
            <button type="button" className={styles.linkButton} onClick={() => setOpen(false)}>
              {t('close')}
            </button>
          </div>
          <div className={styles.pickerList}>
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                className={styles.pickerItem}
                onClick={() => {
                  onPick(model.id)
                  setOpen(false)
                }}
              >
                <span className={styles.pickerId}>{model.id}</span>
                {model.name && model.name !== model.id ? (
                  <span className={styles.pickerName}>{model.name}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <div className={styles.noticeError}>{error}</div> : null}
    </div>
  )
}
