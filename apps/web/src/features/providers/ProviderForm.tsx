import {
  type CreateProviderProfileInput,
  type ProviderCapabilities,
  type ProviderProfile,
  type ProviderTemplate,
  type ProviderUrlValidation,
} from '@xiaochu/shared'
import {
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { ApiClientError } from '../../lib/api-client'

export type ProviderFormValues = Omit<
  CreateProviderProfileInput,
  'apiKey'
> & { readonly apiKey?: string }

export interface ProviderFormProps {
  readonly initialProfile?: ProviderProfile
  readonly onCancel?: () => void
  readonly onSubmit: (value: ProviderFormValues) => Promise<void>
  readonly onValidateUrl: (baseUrl: string) => Promise<ProviderUrlValidation>
}

const TEMPLATE_DEFAULTS: Readonly<Record<ProviderTemplate, {
  readonly baseUrl: string
  readonly modelId: string
  readonly capabilities: ProviderCapabilities
}>> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    capabilities: {
      chat: true,
      stream: true,
      tools: true,
      json: true,
      reasoning: true,
      vision: false,
    },
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelId: 'qwen-plus',
    capabilities: {
      chat: true,
      stream: true,
      tools: true,
      json: true,
      reasoning: false,
      vision: false,
    },
  },
  custom: {
    baseUrl: '',
    modelId: '',
    capabilities: {
      chat: true,
      stream: true,
      tools: false,
      json: false,
      reasoning: false,
      vision: false,
    },
  },
}

type FormState = 'error' | 'idle' | 'loading' | 'success'

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    const messages: Readonly<Record<string, string>> = {
      api_key_required: 'Base URL 已变化，请重新输入 API Key。',
      auth: '鉴权失败，请重新输入 API Key。',
      model_not_found: '没有找到这个 Model ID，请核对后重试。',
      provider_dns_failed: '无法解析这个服务地址，请检查网络或域名。',
      quota: '当前服务额度或余额不足。',
      rate_limited: '请求太频繁，请稍后再试。',
      timeout: '连接超时，请检查服务地址和网络。',
      unsafe_provider_url: '这个服务地址不符合安全规则。',
    }
    return messages[error.code] ?? '模型配置未保存，请检查后重试。'
  }
  return '模型配置未保存，请稍后重试。'
}

export const ProviderForm = ({
  initialProfile,
  onCancel,
  onSubmit,
  onValidateUrl,
}: ProviderFormProps) => {
  const fieldPrefix = useId()
  const apiKeyInput = useRef<HTMLInputElement>(null)
  const initialTemplate = initialProfile?.template ?? 'deepseek'
  const preset = TEMPLATE_DEFAULTS[initialTemplate]
  const [name, setName] = useState(initialProfile?.name ?? 'DeepSeek')
  const [kind, setKind] = useState<'text' | 'vision'>(
    initialProfile?.kind ?? 'text',
  )
  const [template, setTemplate] = useState<ProviderTemplate>(initialTemplate)
  const [baseUrl, setBaseUrl] = useState(
    initialProfile?.baseUrl ?? preset.baseUrl,
  )
  const [modelId, setModelId] = useState(
    initialProfile?.modelId ?? preset.modelId,
  )
  const [capabilities, setCapabilities] = useState<ProviderCapabilities>(
    initialProfile?.capabilities ?? preset.capabilities,
  )
  const [streamEnabled, setStreamEnabled] = useState(
    initialProfile?.streamEnabled ?? preset.capabilities.stream,
  )
  const [enabled, setEnabled] = useState(initialProfile?.enabled ?? true)
  const [formState, setFormState] = useState<FormState>('idle')
  const [message, setMessage] = useState('')
  const [validating, setValidating] = useState(false)

  const setCapability = (
    capability: Exclude<keyof ProviderCapabilities, 'chat'>,
    checked: boolean,
  ): void => {
    setCapabilities((current) => ({ ...current, [capability]: checked }))
    if (capability === 'stream' && !checked) {
      setStreamEnabled(false)
    }
  }

  const selectTemplate = (nextTemplate: ProviderTemplate): void => {
    const next = TEMPLATE_DEFAULTS[nextTemplate]
    setTemplate(nextTemplate)
    if (initialProfile === undefined || nextTemplate !== initialProfile.template) {
      setBaseUrl(next.baseUrl)
      setModelId(next.modelId)
      setCapabilities(next.capabilities)
      setStreamEnabled(next.capabilities.stream)
      setKind('text')
    }
  }

  const selectKind = (nextKind: 'text' | 'vision'): void => {
    setKind(nextKind)
    setCapabilities((current) => ({
      ...current,
      vision: nextKind === 'vision',
    }))
    if (nextKind === 'vision' && template === 'deepseek') {
      selectTemplate('qwen')
      setKind('vision')
      setCapabilities((current) => ({ ...current, vision: true }))
    }
  }

  const validateUrl = async (): Promise<void> => {
    setValidating(true)
    setMessage('')
    try {
      const validation = await onValidateUrl(baseUrl)
      setBaseUrl(validation.normalizedBaseUrl)
      setMessage('地址可用，保存时还会进行一次真实模型连接。')
      setFormState('success')
    } catch (error) {
      setMessage(safeErrorMessage(error))
      setFormState('error')
    } finally {
      setValidating(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setFormState('loading')
    setMessage('')
    const apiKey = apiKeyInput.current?.value ?? ''
    if (initialProfile === undefined && apiKey.length === 0) {
      setFormState('error')
      setMessage('首次保存需要输入 API Key。')
      if (apiKeyInput.current !== null) {
        apiKeyInput.current.value = ''
      }
      return
    }

    try {
      await onSubmit({
        name,
        kind,
        template,
        baseUrl,
        modelId,
        capabilities,
        streamEnabled,
        enabled,
        ...(apiKey.length === 0 ? {} : { apiKey }),
      })
      setFormState('success')
      setMessage('连接测试通过，配置已保存。')
    } catch (error) {
      setFormState('error')
      setMessage(safeErrorMessage(error))
    } finally {
      if (apiKeyInput.current !== null) {
        apiKeyInput.current.value = ''
      }
    }
  }

  const fieldId = (name: string) => `${fieldPrefix}-${name}`
  const busy = formState === 'loading'

  return (
    <form className="provider-form" noValidate onSubmit={(event) => void submit(event)}>
      <div className="provider-form__heading">
        <div>
          <h2>{initialProfile === undefined ? '接入一个模型' : '修改模型配置'}</h2>
          <p>密钥只提交给本机服务；保存后不会再次显示。</p>
        </div>
        {initialProfile?.hasKey === true && (
          <span className="provider-form__key-state">密钥已加密保存</span>
        )}
      </div>

      <div className="provider-form__grid">
        <label className="provider-field" htmlFor={fieldId('name')}>
          <span>显示名称</span>
          <input
            id={fieldId('name')}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>

        <label className="provider-field" htmlFor={fieldId('kind')}>
          <span>用途</span>
          <select
            id={fieldId('kind')}
            onChange={(event) => selectKind(event.target.value as 'text' | 'vision')}
            value={kind}
          >
            <option value="text">文字对话</option>
            <option value="vision">冰箱图片识别</option>
          </select>
        </label>

        <label className="provider-field" htmlFor={fieldId('template')}>
          <span>服务模板</span>
          <select
            id={fieldId('template')}
            onChange={(event) => selectTemplate(event.target.value as ProviderTemplate)}
            value={template}
          >
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">阿里云百炼千问</option>
            <option value="custom">自定义 OpenAI 兼容</option>
          </select>
        </label>

        <label className="provider-field" htmlFor={fieldId('model')}>
          <span>Model ID</span>
          <input
            id={fieldId('model')}
            maxLength={200}
            onChange={(event) => setModelId(event.target.value)}
            required
            spellCheck={false}
            value={modelId}
          />
        </label>

        <label className="provider-field provider-field--wide" htmlFor={fieldId('url')}>
          <span>Base URL</span>
          <div className="provider-field__inline">
            <input
              id={fieldId('url')}
              inputMode="url"
              maxLength={2048}
              onChange={(event) => setBaseUrl(event.target.value)}
              required
              spellCheck={false}
              value={baseUrl}
            />
            <button
              className="provider-button provider-button--quiet"
              disabled={busy || validating || baseUrl.length === 0}
              onClick={() => void validateUrl()}
              type="button"
            >
              {validating ? '检查中…' : '检查地址'}
            </button>
          </div>
        </label>

        <label className="provider-field provider-field--wide" htmlFor={fieldId('key')}>
          <span>API Key</span>
          <input
            autoComplete="new-password"
            id={fieldId('key')}
            maxLength={65536}
            name="provider-api-key"
            placeholder={initialProfile === undefined ? '首次保存必须填写' : '留空则继续使用原密钥'}
            ref={apiKeyInput}
            spellCheck={false}
            type="password"
          />
        </label>
      </div>

      <fieldset className="provider-capabilities">
        <legend>接口能力</legend>
        <label><input checked disabled type="checkbox" />文字对话</label>
        {(['stream', 'tools', 'json', 'reasoning'] as const).map((capability) => (
          <label key={capability}>
            <input
              checked={capabilities[capability]}
              onChange={(event) => setCapability(capability, event.target.checked)}
              type="checkbox"
            />
            {{
              stream: '流式输出',
              tools: '工具调用',
              json: 'JSON 输出',
              reasoning: '推理模型',
            }[capability]}
          </label>
        ))}
        <label>
          <input
            checked={streamEnabled}
            disabled={!capabilities.stream}
            onChange={(event) => setStreamEnabled(event.target.checked)}
            type="checkbox"
          />
          默认使用流式输出
        </label>
        <label>
          <input
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            type="checkbox"
          />
          启用这个配置
        </label>
      </fieldset>

      {message.length > 0 && (
        <p
          aria-live="polite"
          className="provider-form__message"
          data-state={formState}
          role={formState === 'error' ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}

      <div className="provider-form__actions">
        {onCancel !== undefined && (
          <button
            className="provider-button provider-button--quiet"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            取消修改
          </button>
        )}
        <button
          className="provider-button provider-button--primary"
          data-state={formState}
          disabled={busy}
          type="submit"
        >
          {busy ? '正在连接测试…' : '测试连接并保存'}
        </button>
      </div>
    </form>
  )
}
