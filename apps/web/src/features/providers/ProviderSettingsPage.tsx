import {
  type ProviderConnectionResult,
  type ProviderProfile,
  type ProviderUrlValidation,
} from '@xiaochu/shared'
import { useCallback, useEffect, useState } from 'react'
import { apiClient, ApiClientError } from '../../lib/api-client'
import {
  ProviderForm,
  type ProviderFormValues,
} from './ProviderForm'
import './providers.css'

const listErrorMessage = (error: unknown): string => (
  error instanceof ApiClientError && error.code === 'rate_limited'
    ? '请求太频繁，请稍后重试。'
    : '模型配置暂时无法读取，请确认本地服务正在运行。'
)

export const ProviderSettingsPage = () => {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [editing, setEditing] = useState<ProviderProfile | undefined>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [testingId, setTestingId] = useState<string>()
  const [deletingId, setDeletingId] = useState<string>()
  const [actionMessage, setActionMessage] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    void apiClient.request<ProviderProfile[]>('/api/providers', {
      method: 'GET',
      signal: controller.signal,
    }).then((data) => {
      setProfiles(data)
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setLoadError(listErrorMessage(error))
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    })
    return () => controller.abort()
  }, [refreshVersion])

  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1)
  }, [])

  const validateUrl = async (baseUrl: string): Promise<ProviderUrlValidation> => {
    const controller = new AbortController()
    return apiClient.request<ProviderUrlValidation>('/api/providers/validate', {
      body: { baseUrl },
      method: 'POST',
      signal: controller.signal,
    })
  }

  const save = async (value: ProviderFormValues): Promise<void> => {
    const controller = new AbortController()
    const path = editing === undefined
      ? '/api/providers'
      : `/api/providers/${encodeURIComponent(editing.id)}`
    await apiClient.request<ProviderProfile>(path, {
      body: value,
      method: editing === undefined ? 'POST' : 'PATCH',
      signal: controller.signal,
    })
    setEditing(undefined)
    setActionMessage('模型配置已保存。')
    refresh()
  }

  const testProfile = async (profile: ProviderProfile): Promise<void> => {
    const controller = new AbortController()
    setTestingId(profile.id)
    setActionMessage('')
    try {
      const result = await apiClient.request<ProviderConnectionResult>(
        `/api/providers/${encodeURIComponent(profile.id)}/test`,
        { method: 'POST', signal: controller.signal },
      )
      setActionMessage(`${profile.name} 连接成功，模型返回 ${result.model}。`)
      refresh()
    } catch (error) {
      setActionMessage(
        error instanceof ApiClientError && error.code === 'auth'
          ? `${profile.name} 鉴权失败，请点击修改并重新输入 API Key。`
          : `${profile.name} 连接失败，请检查配置后重试。`,
      )
    } finally {
      setTestingId(undefined)
    }
  }

  const deleteProfile = async (profile: ProviderProfile): Promise<void> => {
    if (deletingId !== profile.id) {
      setDeletingId(profile.id)
      setActionMessage(`再次点击“确认删除”即可移除 ${profile.name} 和它的密钥。`)
      return
    }
    const controller = new AbortController()
    try {
      await apiClient.request<void>(
        `/api/providers/${encodeURIComponent(profile.id)}`,
        { method: 'DELETE', signal: controller.signal },
      )
      if (editing?.id === profile.id) {
        setEditing(undefined)
      }
      setActionMessage(`${profile.name} 已删除。`)
      refresh()
    } catch {
      setActionMessage(`${profile.name} 未能删除，请稍后重试。`)
    } finally {
      setDeletingId(undefined)
    }
  }

  return (
    <div className="page provider-settings-page">
      <section className="page-heading provider-settings-page__heading">
        <h1>模型与密钥</h1>
        <p>分别配置文字助手与冰箱识别模型。所有请求都由本机服务转发。</p>
      </section>

      <div className="provider-workbench">
        <section aria-labelledby="provider-list-title" className="provider-list-panel">
          <div className="provider-panel-heading">
            <div>
              <h2 id="provider-list-title">已接入的模型</h2>
              <p>应用只显示是否已保存密钥，不会读取完整内容。</p>
            </div>
            <span>{profiles.length} 个</span>
          </div>

          {loading && <p className="provider-empty">正在读取配置…</p>}
          {loadError.length > 0 && (
            <p className="provider-empty provider-empty--error" role="alert">
              {loadError}
            </p>
          )}
          {!loading && loadError.length === 0 && profiles.length === 0 && (
            <p className="provider-empty">还没有模型配置，从右侧添加第一个。</p>
          )}

          <div className="provider-list">
            {profiles.map((profile) => (
              <article className="provider-card" key={profile.id}>
                <div className="provider-card__topline">
                  <div>
                    <h3>{profile.name}</h3>
                    <span>{profile.kind === 'vision' ? '图片识别' : '文字对话'}</span>
                  </div>
                  <span className="provider-card__status" data-enabled={profile.enabled}>
                    {profile.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <dl>
                  <div><dt>模型</dt><dd>{profile.modelId}</dd></div>
                  <div><dt>地址</dt><dd>{profile.baseUrl}</dd></div>
                  <div><dt>密钥</dt><dd>{profile.hasKey ? '已加密保存' : '未配置'}</dd></div>
                </dl>
                <div className="provider-card__actions">
                  <button
                    className="provider-button provider-button--quiet"
                    disabled={testingId === profile.id}
                    onClick={() => void testProfile(profile)}
                    type="button"
                  >
                    {testingId === profile.id ? '测试中…' : '测试连接'}
                  </button>
                  <button
                    className="provider-button provider-button--quiet"
                    onClick={() => {
                      setEditing(profile)
                      setDeletingId(undefined)
                      setActionMessage('')
                    }}
                    type="button"
                  >
                    修改
                  </button>
                  <button
                    className="provider-button provider-button--danger"
                    data-state={deletingId === profile.id ? 'error' : 'idle'}
                    onClick={() => void deleteProfile(profile)}
                    type="button"
                  >
                    {deletingId === profile.id ? '确认删除' : '删除'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section aria-label={editing === undefined ? '新增模型配置' : '修改模型配置'}>
          <ProviderForm
            key={editing?.id ?? 'new-provider'}
            {...(editing === undefined ? {} : {
              initialProfile: editing,
              onCancel: () => setEditing(undefined),
            })}
            onSubmit={save}
            onValidateUrl={validateUrl}
          />
        </section>
      </div>

      {actionMessage.length > 0 && (
        <p aria-live="polite" className="provider-action-message" role="status">
          {actionMessage}
        </p>
      )}
    </div>
  )
}
