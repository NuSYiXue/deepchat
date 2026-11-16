/**
 * 设置 → 模型：端点与模型的管理面板。
 *
 * 一个端点可以挂多个模型，因此分两层：端点持有 origin / API Key / 方言 / 能力，
 * 模型只描述自己的名字、输入类型、上下文与推理等级。
 *
 * API Key 只写不读：服务端返回 hasKey 与尾部提示，编辑器留空表示保持不变。
 * id 由客户端生成，不让用户填。
 */
import clsx from 'clsx'
import { useState } from 'react'
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
import styles from './Settings.module.css'

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

/** 新建端点时给出可用的默认值；id 隐藏生成 */
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

/** 新建模型时套用常见默认值，减少必填项 */
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

export const ModelSettings = () => {
  const t = useTranslate()
  const { endpoints, models } = useConfig()
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointDraft | null>(null)
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null)
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

  const submitEndpoint = async () => {
    if (!editingEndpoint) {
      return
    }
    const draft = editingEndpoint
    await run(async () => {
      await saveEndpoint({
        id: draft.id,
        name: draft.name.trim(),
        origin: draft.origin.trim(),
        // 留空表示沿用已保存的 Key
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        dialect: draft.dialect,
        capabilities: { nativeWebSearch: draft.nativeWebSearch },
      })
      setEditingEndpoint(null)
    })
  }

  const submitModel = async () => {
    if (!editingModel) {
      return
    }
    await run(async () => {
      await saveModel(editingModel)
      setEditingModel(null)
    })
  }

  return (
    <div>
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.groupTitle}>{t('settingsEndpoints')}</div>
      {endpoints.map((endpoint) => (
        <div key={endpoint.id} className={styles.cell}>
          <div className={styles.row}>
            <div className={clsx(styles.text, styles.textDense)}>
              <div className={styles.label}>{endpoint.name}</div>
              <div className={styles.description}>
                {endpoint.origin}
                {' · '}
                {endpoint.dialect}
                {' · '}
                {endpoint.hasKey ? t('settingsKeyConfigured') : t('settingsKeyMissing')}
              </div>
            </div>
            <div className={styles.cellActions}>
              <Button
                variant="outlined"
                size="m"
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
              <Button
                variant="outlined"
                size="m"
                disabled={busy}
                onClick={() => setEditingEndpoint(draftFrom(endpoint))}
              >
                {t('edit')}
              </Button>
            </div>
          </div>
        </div>
      ))}

      {editingEndpoint ? (
        <EndpointForm
          value={editingEndpoint}
          busy={busy}
          isNew={!endpoints.some((item) => item.id === editingEndpoint.id)}
          onChange={setEditingEndpoint}
          onSubmit={() => void submitEndpoint()}
          onCancel={() => setEditingEndpoint(null)}
        />
      ) : (
        <div className={styles.cell}>
          <Button
            variant="outlined"
            size="m"
            disabled={busy}
            onClick={() => setEditingEndpoint(emptyEndpoint())}
          >
            {t('settingsAddEndpoint')}
          </Button>
        </div>
      )}

      <div className={styles.groupTitle}>{t('settingsModels')}</div>
      {models.map((model) => (
        <div key={model.id} className={styles.cell}>
          <div className={styles.row}>
            <div className={clsx(styles.text, styles.textDense)}>
              <div className={styles.label}>
                {model.name || model.model}
                {model.isDefault ? ` · ${t('settingsDefault')}` : ''}
              </div>
              <div className={styles.description}>
                {model.model}
                {' · '}
                {model.inputTypes.join(' / ')}
                {' · '}
                {model.maxContext} ctx
              </div>
            </div>
            <div className={styles.cellActions}>
              <Button
                variant="outlined"
                size="m"
                disabled={busy}
                onClick={() => setEditingModel(model)}
              >
                {t('edit')}
              </Button>
              <Button
                variant="dangerOutlined"
                size="m"
                disabled={busy || model.isDefault}
                onClick={() => void run(() => deleteModel(model.id))}
              >
                {t('delete')}
              </Button>
            </div>
          </div>
        </div>
      ))}

      {editingModel ? (
        <ModelForm
          value={editingModel}
          endpoints={endpoints}
          busy={busy}
          isNew={!models.some((item) => item.id === editingModel.id)}
          onChange={setEditingModel}
          onSubmit={() => void submitModel()}
          onCancel={() => setEditingModel(null)}
        />
      ) : endpoints.length > 0 ? (
        <div className={styles.cell}>
          <Button
            variant="outlined"
            size="m"
            disabled={busy}
            onClick={() => setEditingModel(emptyModel(endpoints[0].id))}
          >
            {t('settingsAddModel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

const EndpointForm = ({
  value,
  busy,
  isNew,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: EndpointDraft
  busy: boolean
  isNew: boolean
  onChange: (value: EndpointDraft) => void
  onSubmit: () => void
  onCancel: () => void
}) => {
  const t = useTranslate()
  return (
    <div className={styles.formSection}>
      <div className={styles.formTitle}>
        {isNew ? t('settingsEndpointNew') : t('settingsEndpointEdit')}
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsEndpointName')}</div>
        <input
          className={styles.fieldInput}
          value={value.name}
          placeholder={t('settingsEndpointNamePlaceholder')}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsEndpointOrigin')}</div>
        <input
          className={styles.fieldInput}
          value={value.origin}
          placeholder="https://api.deepseek.com"
          spellCheck={false}
          onChange={(e) => onChange({ ...value, origin: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsEndpointKey')}</div>
        <input
          className={styles.fieldInput}
          type="password"
          autoComplete="off"
          placeholder={isNew ? t('settingsEndpointKeyPlaceholder') : t('settingsEndpointKeyKeep')}
          value={value.apiKey}
          onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsEndpointDialect')}</div>
        <Select
          ariaLabel={t('settingsEndpointDialect')}
          className={styles.fieldSelect}
          value={value.dialect}
          options={DIALECTS.map((dialect) => ({ value: dialect, label: dialect }))}
          onChange={(dialect) => onChange({ ...value, dialect })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.checkboxItem}>
          <input
            type="checkbox"
            checked={value.nativeWebSearch}
            onChange={(e) => onChange({ ...value, nativeWebSearch: e.target.checked })}
          />
          {t('settingsNativeSearch')}
        </label>
      </div>

      <div className={styles.formActions}>
        <Button variant="outlined" size="m" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          size="m"
          disabled={busy || value.name.trim() === '' || value.origin.trim() === ''}
          onClick={onSubmit}
        >
          {t('confirm')}
        </Button>
      </div>
    </div>
  )
}

const ModelForm = ({
  value,
  endpoints,
  busy,
  isNew,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: ModelConfig
  endpoints: Endpoint[]
  busy: boolean
  isNew: boolean
  onChange: (value: ModelConfig) => void
  onSubmit: () => void
  onCancel: () => void
}) => {
  const t = useTranslate()
  const toggleInput = (type: string) => {
    const has = value.inputTypes.includes(type)
    onChange({
      ...value,
      inputTypes: has
        ? value.inputTypes.filter((item) => item !== type)
        : [...value.inputTypes, type],
    })
  }

  return (
    <div className={styles.formSection}>
      <div className={styles.formTitle}>
        {isNew ? t('settingsModelNew') : t('settingsModelEdit')}
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsModelEndpoint')}</div>
        <Select
          ariaLabel={t('settingsModelEndpoint')}
          className={styles.fieldSelect}
          value={value.endpointId}
          options={endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name }))}
          onChange={(endpointId) => onChange({ ...value, endpointId })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsModelUpstream')}</div>
        <input
          className={styles.fieldInput}
          value={value.model}
          placeholder="deepseek-flash"
          spellCheck={false}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsModelName')}</div>
        <input
          className={styles.fieldInput}
          value={value.name}
          placeholder={t('settingsModelNamePlaceholder')}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsInputTypes')}</div>
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
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsMaxContext')}</div>
        <input
          className={styles.fieldInput}
          type="number"
          value={value.maxContext}
          onChange={(e) => onChange({ ...value, maxContext: Number(e.target.value) })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsMaxOutput')}</div>
        <input
          className={styles.fieldInput}
          type="number"
          value={value.maxOutput}
          onChange={(e) => onChange({ ...value, maxOutput: Number(e.target.value) })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>{t('settingsReasoning')}</div>
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
      </div>

      <div className={styles.field}>
        <label className={styles.checkboxItem}>
          <input
            type="checkbox"
            checked={value.isDefault}
            onChange={(e) => onChange({ ...value, isDefault: e.target.checked })}
          />
          {t('settingsDefault')}
        </label>
      </div>

      <div className={styles.formActions}>
        <Button variant="outlined" size="m" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          size="m"
          disabled={busy || value.model.trim() === ''}
          onClick={onSubmit}
        >
          {t('confirm')}
        </Button>
      </div>
    </div>
  )
}
