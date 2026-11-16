/**
 * 设置 → 模型：端点与模型的管理面板。
 *
 * 一个端点可以挂多个模型，因此分两层：端点持有 origin / API Key / 方言 / 能力，
 * 模型只描述自己的名字、输入类型、上下文与推理等级。
 *
 * API Key 只写不读：服务端返回 hasKey 与尾部提示，编辑器留空表示保持不变。
 */
import { useState } from 'react'
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

const emptyEndpoint = (): EndpointDraft => ({
  id: '',
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

export const ModelSettings = () => {
  const t = useTranslate()
  const { endpoints, models } = useConfig()
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointDraft | null>(null)
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>, success?: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (success) {
        showToast({ key: 'settingsSaved' })
      }
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
        name: draft.name,
        origin: draft.origin,
        // 留空表示沿用已保存的 Key
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        dialect: draft.dialect,
        capabilities: { nativeWebSearch: draft.nativeWebSearch },
      })
      setEditingEndpoint(null)
    }, 'saved')
  }

  const submitModel = async () => {
    if (!editingModel) {
      return
    }
    const model = editingModel
    await run(async () => {
      await saveModel(model)
      setEditingModel(null)
    }, 'saved')
  }

  return (
    <div>
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.label}>{t('settingsEndpoints')}</div>
      {endpoints.map((endpoint) => (
        <div key={endpoint.id} className={styles.cell}>
          <div className={styles.row}>
            <div className={styles.text}>
              <div className={styles.label}>{endpoint.name}</div>
              <div className={styles.description}>
                {endpoint.origin} · {endpoint.dialect} ·{' '}
                {endpoint.hasKey ? t('settingsKeyConfigured') : t('settingsKeyMissing')}
                {endpoint.keyHint ? ` (${endpoint.keyHint})` : ''}
              </div>
            </div>
            <div>
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
              </Button>{' '}
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
        <div className={styles.cell}>
          <div className={styles.label}>{t('settingsEndpointNew')}</div>
          <input
            className={styles.apiKeyInput}
            placeholder={t('settingsEndpointId')}
            value={editingEndpoint.id}
            onChange={(e) => setEditingEndpoint({ ...editingEndpoint, id: e.target.value })}
          />
          <input
            className={styles.apiKeyInput}
            placeholder={t('settingsEndpointName')}
            value={editingEndpoint.name}
            onChange={(e) => setEditingEndpoint({ ...editingEndpoint, name: e.target.value })}
          />
          <input
            className={styles.apiKeyInput}
            placeholder="https://api.deepseek.com"
            value={editingEndpoint.origin}
            onChange={(e) => setEditingEndpoint({ ...editingEndpoint, origin: e.target.value })}
          />
          <input
            className={styles.apiKeyInput}
            type="password"
            placeholder={t('settingsEndpointKeyHint')}
            autoComplete="off"
            value={editingEndpoint.apiKey}
            onChange={(e) => setEditingEndpoint({ ...editingEndpoint, apiKey: e.target.value })}
          />
          <select
            className={styles.apiKeyInput}
            value={editingEndpoint.dialect}
            onChange={(e) => setEditingEndpoint({ ...editingEndpoint, dialect: e.target.value })}
          >
            {DIALECTS.map((dialect) => (
              <option key={dialect} value={dialect}>
                {dialect}
              </option>
            ))}
          </select>
          <label className={styles.description}>
            <input
              type="checkbox"
              checked={editingEndpoint.nativeWebSearch}
              onChange={(e) =>
                setEditingEndpoint({ ...editingEndpoint, nativeWebSearch: e.target.checked })
              }
            />{' '}
            {t('settingsNativeSearch')}
          </label>
          <div>
            <Button variant="primary" size="m" disabled={busy} onClick={() => void submitEndpoint()}>
              {t('confirm')}
            </Button>{' '}
            <Button
              variant="outlined"
              size="m"
              disabled={busy}
              onClick={() => setEditingEndpoint(null)}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outlined"
          size="m"
          onClick={() => setEditingEndpoint(emptyEndpoint())}
        >
          {t('settingsAddEndpoint')}
        </Button>
      )}

      <div className={styles.label}>{t('settingsModels')}</div>
      {models.map((model) => (
        <div key={model.id} className={styles.cell}>
          <div className={styles.row}>
            <div className={styles.text}>
              <div className={styles.label}>
                {model.name || model.model}
                {model.isDefault ? ` · ${t('settingsDefault')}` : ''}
              </div>
              <div className={styles.description}>
                {model.model} · {model.inputTypes.join('/')} · {model.maxContext} ctx
                {model.reasoning.kind !== 'none' ? ` · ${model.reasoning.kind}` : ''}
              </div>
            </div>
            <div>
              <Button
                variant="outlined"
                size="m"
                disabled={busy}
                onClick={() => setEditingModel(model)}
              >
                {t('edit')}
              </Button>{' '}
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
        <ModelEditor
          value={editingModel}
          endpoints={endpoints}
          busy={busy}
          onChange={setEditingModel}
          onSubmit={() => void submitModel()}
          onCancel={() => setEditingModel(null)}
        />
      ) : endpoints.length > 0 ? (
        <Button
          variant="outlined"
          size="m"
          onClick={() =>
            setEditingModel({
              id: '',
              endpointId: endpoints[0].id,
              name: '',
              model: '',
              inputTypes: ['text'],
              maxContext: 64000,
              maxOutput: 8192,
              reasoning: { kind: 'none' },
              isDefault: false,
            })
          }
        >
          {t('settingsAddModel')}
        </Button>
      ) : null}
    </div>
  )
}

const ModelEditor = ({
  value,
  endpoints,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: ModelConfig
  endpoints: Endpoint[]
  busy: boolean
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
    <div className={styles.cell}>
      <div className={styles.label}>{value.id ? t('settingsModelEdit') : t('settingsModelNew')}</div>
      <input
        className={styles.apiKeyInput}
        placeholder={t('settingsModelId')}
        value={value.id}
        disabled={Boolean(value.id)}
        onChange={(e) => onChange({ ...value, id: e.target.value })}
      />
      <input
        className={styles.apiKeyInput}
        placeholder={t('settingsModelName')}
        value={value.name}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
      <input
        className={styles.apiKeyInput}
        placeholder={t('settingsModelUpstream')}
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
      />
      <select
        className={styles.apiKeyInput}
        value={value.endpointId}
        onChange={(e) => onChange({ ...value, endpointId: e.target.value })}
      >
        {endpoints.map((endpoint) => (
          <option key={endpoint.id} value={endpoint.id}>
            {endpoint.name}
          </option>
        ))}
      </select>

      <div className={styles.description}>{t('settingsInputTypes')}</div>
      {INPUT_TYPES.map((type) => (
        <label key={type} className={styles.description}>
          <input
            type="checkbox"
            checked={value.inputTypes.includes(type)}
            onChange={() => toggleInput(type)}
          />{' '}
          {type}
        </label>
      ))}

      <input
        className={styles.apiKeyInput}
        type="number"
        placeholder={t('settingsMaxContext')}
        value={value.maxContext}
        onChange={(e) => onChange({ ...value, maxContext: Number(e.target.value) })}
      />
      <input
        className={styles.apiKeyInput}
        type="number"
        placeholder={t('settingsMaxOutput')}
        value={value.maxOutput}
        onChange={(e) => onChange({ ...value, maxOutput: Number(e.target.value) })}
      />

      <div className={styles.description}>{t('settingsReasoning')}</div>
      <select
        className={styles.apiKeyInput}
        value={value.reasoning.kind}
        onChange={(e) =>
          onChange({
            ...value,
            reasoning: { kind: e.target.value as 'none' | 'budget' | 'effort' },
          })
        }
      >
        <option value="none">{t('settingsReasoningNone')}</option>
        <option value="budget">{t('settingsReasoningBudget')}</option>
        <option value="effort">{t('settingsReasoningEffort')}</option>
      </select>

      <label className={styles.description}>
        <input
          type="checkbox"
          checked={value.isDefault}
          onChange={(e) => onChange({ ...value, isDefault: e.target.checked })}
        />{' '}
        {t('settingsDefault')}
      </label>

      <div>
        <Button variant="primary" size="m" disabled={busy} onClick={onSubmit}>
          {t('confirm')}
        </Button>{' '}
        <Button variant="outlined" size="m" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}
