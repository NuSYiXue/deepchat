/**
 * 设置 → 搜索服务：给不支持原生联网搜索的模型配一个搜索 API。
 *
 * 与模型端点解耦。内置 DeepSeek 端点不参与——它有自己的原生搜索，替别的
 * 模型搜反而会消耗用户没预期的额度。
 *
 * 两种预设：
 * - DeepSeek：/v1/tools/search，字段结构固定，只需填 Key；
 * - 自定义：自己填 URL 与响应字段路径，接 Tavily / Serper / 自建服务等。
 */
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getSearchConfig,
  reloadConfig,
  saveSearchConfig,
  testSearchConfig,
  type SearchConfig,
  type SearchConfigView,
} from '../../services/server/config.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'
import modelStyles from './ModelSettings.module.css'

const EMPTY: SearchConfig = {
  enabled: true,
  preset: 'deepseek',
  url: 'https://api.deepseek.com/v1/tools/search',
  headers: '',
  resultsPath: 'results',
  titleField: 'title',
  urlField: 'url',
  snippetField: 'snippet',
  fetchUrl: 'https://api.deepseek.com/v1/tools/fetch',
}

export const SearchSettings = () => {
  const t = useTranslate()
  const [config, setConfig] = useState<SearchConfig>(EMPTY)
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState<string | null>(null)

  useEffect(() => {
    void getSearchConfig()
      .then((view: SearchConfigView) => {
        // hasKey / configured 是服务端附加的展示字段，不属于可编辑配置
        const { hasKey: keyed, configured, ...rest } = view
        void configured
        setConfig({ ...EMPTY, ...rest })
        setHasKey(keyed)
      })
      .catch(() => {
        // 读不到就保持默认值，保存时会覆盖
      })
  }, [])

  const run = async (action: () => Promise<void>, successToast = true) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (successToast) {
        showToast({ key: 'settingsSaved' })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 切换预设时带出该预设的默认地址与字段，用户仍可改 */
  const setPreset = (preset: SearchConfig['preset']) => {
    setConfig((current) =>
      preset === 'deepseek'
        ? {
            ...current,
            preset,
            url: 'https://api.deepseek.com/v1/tools/search',
            fetchUrl: 'https://api.deepseek.com/v1/tools/fetch',
            resultsPath: 'results',
            titleField: 'title',
            urlField: 'url',
            snippetField: 'snippet',
          }
        : { ...current, preset }
    )
    setTested(null)
  }

  const save = () =>
    run(async () => {
      await saveSearchConfig({
        ...config,
        // 没输入就保持原 Key
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      })
      if (apiKey.trim() !== '') {
        setHasKey(true)
        setApiKey('')
      }
      // 让聊天窗口的「智能搜索」按钮立刻反映新状态
      await reloadConfig()
    })

  const test = () =>
    run(async () => {
      const result = await testSearchConfig({
        ...config,
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      })
      setTested(
        result.hits.length === 0
          ? t('settingsSearchTestEmpty', { ms: String(result.latencyMs) })
          : t('settingsSearchTestOk', {
              ms: String(result.latencyMs),
              count: String(result.hits.length),
              first: result.hits[0].title.slice(0, 30),
            })
      )
    }, false)

  return (
    <div className={styles.content}>
      {error ? <div className={styles.error}>{error}</div> : null}

      {/* 总开关 */}
      <div className={styles.cell}>
        <div className={styles.row}>
          <div className={styles.text}>
            <div className={styles.label}>{t('settingsSearchEnabled')}</div>
            <div className={styles.description}>{t('settingsSearchEnabledHint')}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.enabled}
            aria-label={t('settingsSearchEnabled')}
            className={clsx(modelStyles.switch, config.enabled && modelStyles.switchOn)}
            disabled={busy}
            onClick={() => setConfig({ ...config, enabled: !config.enabled })}
          >
            <span className={modelStyles.switchKnob} />
          </button>
        </div>
      </div>

      {/* 预设选择 */}
      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>{t('settingsSearchPreset')}</div>
          <div className={styles.row}>
            <button
              type="button"
              className={clsx(
                modelStyles.secondaryButton,
                config.preset === 'deepseek' && modelStyles.secondaryButtonActive
              )}
              disabled={busy}
              onClick={() => setPreset('deepseek')}
            >
              {t('settingsSearchPresetDeepSeek')}
            </button>
            <button
              type="button"
              className={clsx(
                modelStyles.secondaryButton,
                config.preset === 'custom' && modelStyles.secondaryButtonActive
              )}
              disabled={busy}
              onClick={() => setPreset('custom')}
            >
              {t('settingsSearchPresetCustom')}
            </button>
          </div>
          <div className={styles.description}>
            {config.preset === 'deepseek'
              ? t('settingsSearchPresetDeepSeekHint')
              : t('settingsSearchPresetCustomHint')}
          </div>
        </div>
      </div>

      {/* 请求地址 */}
      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>{t('settingsSearchUrl')}</div>
          <input
            className={styles.fieldInput}
            value={config.url}
            spellCheck={false}
            placeholder="https://api.deepseek.com/v1/tools/search"
            onChange={(event) => setConfig({ ...config, url: event.target.value })}
          />
        </div>
      </div>

      {/* 网页读取地址：自定义端点靠它读取网页正文 */}
      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>{t('settingsSearchFetchUrl')}</div>
          <input
            className={styles.fieldInput}
            value={config.fetchUrl}
            spellCheck={false}
            placeholder="https://api.deepseek.com/v1/tools/fetch"
            onChange={(event) => setConfig({ ...config, fetchUrl: event.target.value })}
          />
          <div className={styles.description}>{t('settingsSearchFetchUrlHint')}</div>
        </div>
      </div>

      {/* API Key */}
      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>{t('settingsSearchKey')}</div>
          <input
            className={styles.fieldInput}
            type="password"
            value={apiKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={hasKey ? t('settingsSearchKeyKeep') : t('settingsSearchKeyPlaceholder')}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <div className={styles.description}>
            {hasKey ? t('settingsSearchKeySaved') : t('settingsSearchKeyMissing')}
          </div>
        </div>
      </div>

      {/* 自定义模式的字段映射 */}
      {config.preset === 'custom' ? (
        <>
          <div className={styles.cell}>
            <div className={styles.field}>
              <div className={styles.fieldLabel}>{t('settingsSearchHeaders')}</div>
              <textarea
                className={styles.fieldInput}
                rows={2}
                value={config.headers}
                spellCheck={false}
                placeholder='{"X-Api-Key": "..."}'
                onChange={(event) => setConfig({ ...config, headers: event.target.value })}
              />
              <div className={styles.description}>{t('settingsSearchHeadersHint')}</div>
            </div>
          </div>

          <div className={styles.cell}>
            <div className={styles.field}>
              <div className={styles.fieldLabel}>{t('settingsSearchResultsPath')}</div>
              <input
                className={styles.fieldInput}
                value={config.resultsPath}
                spellCheck={false}
                placeholder="results"
                onChange={(event) => setConfig({ ...config, resultsPath: event.target.value })}
              />
              <div className={styles.description}>{t('settingsSearchResultsPathHint')}</div>
            </div>
          </div>

          <div className={styles.cell}>
            <div className={styles.field}>
              <div className={styles.fieldLabel}>{t('settingsSearchFields')}</div>
              <div className={styles.row}>
                <input
                  className={styles.fieldInput}
                  value={config.titleField}
                  spellCheck={false}
                  placeholder="title"
                  aria-label={t('settingsSearchTitleField')}
                  onChange={(event) => setConfig({ ...config, titleField: event.target.value })}
                />
                <input
                  className={styles.fieldInput}
                  value={config.urlField}
                  spellCheck={false}
                  placeholder="url"
                  aria-label={t('settingsSearchUrlField')}
                  onChange={(event) => setConfig({ ...config, urlField: event.target.value })}
                />
                <input
                  className={styles.fieldInput}
                  value={config.snippetField}
                  spellCheck={false}
                  placeholder="snippet"
                  aria-label={t('settingsSearchSnippetField')}
                  onChange={(event) => setConfig({ ...config, snippetField: event.target.value })}
                />
              </div>
              <div className={styles.description}>{t('settingsSearchFieldsHint')}</div>
            </div>
          </div>
        </>
      ) : null}

      {/* 操作 */}
      <div className={styles.cell}>
        <div className={styles.row}>
          <div className={styles.text}>
            {tested ? <div className={styles.description}>{tested}</div> : null}
          </div>
          <div className={styles.cellActions}>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => void test()}>
              {t('settingsSearchTest')}
            </Button>
            <Button variant="primary" size="m" disabled={busy} onClick={() => void save()}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
