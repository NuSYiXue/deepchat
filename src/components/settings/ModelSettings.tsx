/**
 * 设置 → 模型：提供商（端点）为行，模型内嵌在端点卡片里。
 *
 * 层级参考 DeepSeekRuntime 的 Models 页面：端点是一等实体，模型从属于端点。
 * 一个端点可以挂多个模型，模型不可能脱离端点存在，所以不该是平级的两份列表。
 *
 * 交互：
 * - 收起态：每个端点一行，显示端点名、模型数量；
 * - 展开态：同一行变成卡片，上半部分是连接配置，下半部分是模型列表；
 * - 模型行同样可展开，编辑上下文、输出上限、输入类型与推理方式。
 *
 * 同一时间只展开一个端点，避免多张长卡片堆叠。
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
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { IconChevronDownOutline14, IconTrashOutline16 } from '../base/icons.js'
import styles from './Settings.module.css'

const DIALECTS = ['deepseek', 'anthropic', 'openai'] as const
const INPUT_TYPES = ['text', 'image', 'document'] as const

/** 端点的可编辑字段；id 隐藏生成，用户只面对有意义的配置 */
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
  /** 展开的端点 id；null 表示全部收起 */
  const [expandedId, setExpandedId] = useState<string | null>(null)
  /** 新建端点的草稿；非 null 时渲染一张未保存的卡片 */
  const [newEndpoint, setNewEndpoint] = useState<EndpointDraft | null>(null)
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
    <div>
      {error ? <div className={styles.error}>{error}</div> : null}

      {endpoints.map((endpoint) => (
        <ProviderCard
          key={endpoint.id}
          endpoint={endpoint}
          models={models.filter((model) => model.endpointId === endpoint.id)}
          expanded={expandedId === endpoint.id}
          busy={busy}
          run={run}
          onToggle={() =>
            setExpandedId((current) => (current === endpoint.id ? null : endpoint.id))
          }
        />
      ))}

      {newEndpoint ? (
        <ProviderCard
          draft={newEndpoint}
          models={[]}
          expanded
          busy={busy}
          run={run}
          onChangeDraft={setNewEndpoint}
          onToggle={() => setNewEndpoint(null)}
          onSaved={() => setNewEndpoint(null)}
        />
      ) : (
        <div className={styles.cell}>
          <Button
            variant="outlined"
            size="m"
            disabled={busy}
            onClick={() => {
              setExpandedId(null)
              setNewEndpoint(emptyEndpoint())
            }}
          >
            {t('settingsAddEndpoint')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * 一个端点：收起时是一行，展开时是卡片。
 *
 * 新建端点没有已保存的 endpoint，此时由 draft 驱动输入框；保存成功后
 * 上层清空 draft，同一位置重新渲染成正式行。
 */
const ProviderCard = ({
  endpoint,
  draft: draftProp,
  models,
  expanded,
  busy,
  run,
  onChangeDraft,
  onToggle,
  onSaved,
}: {
  endpoint?: Endpoint
  draft?: EndpointDraft
  models: ModelConfig[]
  expanded: boolean
  busy: boolean
  run: Run
  onChangeDraft?: (draft: EndpointDraft) => void
  onToggle: () => void
  onSaved?: () => void
}) => {
  const t = useTranslate()
  /** 编辑已有端点时的临时草稿；null 表示沿用已保存值 */
  const [localDraft, setLocalDraft] = useState<EndpointDraft | null>(null)
  /** 正在编辑的模型草稿；null 表示没有打开模型编辑器 */
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
        // 没填名称时用地址兜底，保证列表里可辨认
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

  const title = endpoint?.name ?? (draft?.name.trim() ? draft.name : t('settingsEndpointNew'))
  const meta = endpoint?.origin ?? draft?.origin ?? ''
  const count = models.length

  return (
    <div className={styles.provider}>
      <button
        type="button"
        className={styles.providerHeader}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={clsx(styles.chevron, expanded && styles.chevronOpen)}>
          <IconChevronDownOutline14 />
        </span>
        <span className={styles.providerTitle}>{title}</span>
        <span className={styles.providerMeta}>
          {meta}
          {count > 0 ? ` · ${t('settingsModelCount', { count })}` : ''}
        </span>
      </button>

      {expanded ? (
        <div className={styles.providerBody}>
          {endpoint ? (
            <div className={styles.providerToolbar}>
              <Button
                variant="outlined"
                size="s"
                disabled={busy || !endpoint.hasKey}
                onClick={() =>
                  void run(async () => {
                    await testEndpoint(endpoint.id)
                    showToast({ key: 'settingsTestOk' })
                  })
                }
              >
                {t('settingsTest')}
              </Button>
            </div>
          ) : null}

          <div className={styles.fieldGrid}>
            <Field label={t('settingsEndpointName')}>
              <input
                className={styles.fieldInput}
                value={draft?.name ?? ''}
                placeholder={t('settingsEndpointNamePlaceholder')}
                onChange={(e) => draft && setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label={t('settingsEndpointOrigin')}>
              <input
                className={styles.fieldInput}
                value={draft?.origin ?? ''}
                placeholder="https://api.deepseek.com"
                spellCheck={false}
                onChange={(e) => draft && setDraft({ ...draft, origin: e.target.value })}
              />
            </Field>
            <Field label={t('settingsEndpointKey')}>
              <input
                className={styles.fieldInput}
                type="password"
                autoComplete="off"
                placeholder={
                  endpoint?.hasKey
                    ? t('settingsEndpointKeyKeep')
                    : t('settingsEndpointKeyPlaceholder')
                }
                value={draft?.apiKey ?? ''}
                onChange={(e) => draft && setDraft({ ...draft, apiKey: e.target.value })}
              />
            </Field>
            <Field label={t('settingsEndpointDialect')}>
              <Select
                ariaLabel={t('settingsEndpointDialect')}
                className={styles.fieldSelect}
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

          <div className={styles.formActions}>
            <Button
              variant="primary"
              size="s"
              disabled={busy || !draft?.origin.trim() || !draft.name.trim()}
              onClick={() => void saveEndpointConfig()}
            >
              {t('confirm')}
            </Button>
          </div>

          {/* 模型列表：从属于这个端点 */}
          {endpoint ? (
            <div className={styles.modelList}>
              <div className={styles.modelListTitle}>{t('settingsModels')}</div>

              {models.map((model) => (
                <div key={model.id} className={styles.modelRow}>
                  <div className={styles.modelRowMain}>
                    <button
                      type="button"
                      className={styles.modelRowHeader}
                      aria-expanded={modelDraft?.id === model.id}
                      onClick={() =>
                        setModelDraft((current) => (current?.id === model.id ? null : model))
                      }
                    >
                      <span
                        className={clsx(
                          styles.chevron,
                          modelDraft?.id === model.id && styles.chevronOpen
                        )}
                      >
                        <IconChevronDownOutline14 />
                      </span>
                      <span className={styles.modelRowName}>
                        {model.name || model.model}
                        {model.isDefault ? ` · ${t('settingsDefault')}` : ''}
                      </span>
                      <span className={styles.modelRowMeta}>
                        {model.model}
                        {' · '}
                        {model.inputTypes.join(' / ')}
                        {' · '}
                        {model.maxContext} ctx
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.modelRowDelete}
                      aria-label={`${t('delete')} ${model.name || model.model}`}
                      disabled={busy || model.isDefault}
                      onClick={() => void run(() => deleteModel(model.id))}
                    >
                      <IconTrashOutline16 />
                    </button>
                  </div>

                  {modelDraft?.id === model.id ? (
                    <ModelEditor
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
              ))}

              {/* 新建模型的编辑器：draft 的 id 不在已有列表里 */}
              {modelDraft && !models.some((item) => item.id === modelDraft.id) ? (
                <ModelEditor
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

              <div className={styles.formActions}>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={busy || modelDraft !== null}
                  onClick={() => setModelDraft(emptyModel(endpoint.id))}
                >
                  {t('settingsAddModel')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className={styles.field}>
    <div className={styles.fieldLabel}>{label}</div>
    {children}
  </div>
)

const ModelEditor = ({
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
    <div className={styles.modelEditor}>
      <div className={styles.fieldGrid}>
        <Field label={t('settingsModelUpstream')}>
          <input
            className={styles.fieldInput}
            value={value.model}
            placeholder="deepseek-flash"
            spellCheck={false}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
        </Field>
        <Field label={t('settingsModelName')}>
          <input
            className={styles.fieldInput}
            value={value.name}
            placeholder={t('settingsModelNamePlaceholder')}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </Field>
        <Field label={t('settingsMaxContext')}>
          <input
            className={styles.fieldInput}
            type="number"
            value={value.maxContext}
            onChange={(e) => onChange({ ...value, maxContext: Number(e.target.value) })}
          />
        </Field>
        <Field label={t('settingsMaxOutput')}>
          <input
            className={styles.fieldInput}
            type="number"
            value={value.maxOutput}
            onChange={(e) => onChange({ ...value, maxOutput: Number(e.target.value) })}
          />
        </Field>
      </div>

      <Field label={t('settingsInputTypes')}>
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
      </Field>

      <Field label={t('settingsReasoning')}>
        <Select
          ariaLabel={t('settingsReasoning')}
          className={styles.fieldSelect}
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

      <div className={styles.formActions}>
        <Button variant="outlined" size="s" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          size="s"
          disabled={busy || !value.model.trim()}
          onClick={onSubmit}
        >
          {t('confirm')}
        </Button>
      </div>
    </div>
  )
}
