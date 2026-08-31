import { useQuery } from '@tanstack/react-query'
import { type PendingActionPreview, providerProfileListSchema, type ProviderProfile, type RecipeVariantDetail } from '@xiaochu/shared'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiClientError, apiClient } from '../../lib/api-client'
import { VariantPreview } from './VariantPreview'
import '../inventory/kitchen.css'

export const ModifyRecipePage = () => {
  const recipeId = useParams().recipeId ?? ''
  const providers = useQuery({ queryKey: ['providers', 'text'], queryFn: async ({ signal }) => providerProfileListSchema.parse(await apiClient.request<unknown>('/api/providers', { method: 'GET', signal })).filter((provider) => provider.kind === 'text' && provider.enabled && provider.capabilities.json) })
  const [providerId, setProviderId] = useState('')
  const [servings, setServings] = useState('')
  const [lessOil, setLessOil] = useState(false)
  const [lessSalt, setLessSalt] = useState(false)
  const [noSugar, setNoSugar] = useState(false)
  const [customRequirements, setCustomRequirements] = useState('')
  const [preview, setPreview] = useState<Extract<PendingActionPreview, { kind: 'recipe_variant' }> | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState(false)
  const selectedProvider = providerId || providers.data?.[0]?.id || ''
  const generate = async (): Promise<void> => { if (!selectedProvider) { setError('请先在“我的”中配置并启用支持 JSON 的文本模型'); return } setPending(true); setError(undefined); try { const result = await apiClient.request<PendingActionPreview>(`/api/recipes/${encodeURIComponent(recipeId)}/variants/preview`, { method: 'POST', body: { providerId: selectedProvider, ...(Number(servings) > 0 ? { targetServings: Number(servings) } : {}), adjustments: { lessOil, lessSalt, noSugar, spiceLevel: 'unchanged' }, dietaryRequirements: [], substitutions: [], ...(customRequirements.trim() ? { customRequirements: customRequirements.trim() } : {}), inventoryItemIds: [] }, signal: new AbortController().signal }); if (result.kind === 'recipe_variant') setPreview(result) } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : '无法生成改菜谱预览，原食谱保持不变') } finally { setPending(false) } }
  const confirm = async (): Promise<void> => { if (preview === undefined) return; setPending(true); try { const result = await apiClient.request<RecipeVariantDetail>(`/api/recipes/${encodeURIComponent(recipeId)}/variants/confirm`, { method: 'POST', body: { pendingActionId: preview.pendingActionId }, signal: new AbortController().signal }); setPreview(undefined); setError(`已保存“${result.name}”，原食谱没有改动。`) } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : '保存失败，请重新生成预览') } finally { setPending(false) } }
  return <section className="page kitchen-page"><Link className="detail-back-link" to={`/recipes/${encodeURIComponent(recipeId)}`}>← 回到原食谱</Link><header className="page-heading"><p className="eyebrow">AI 改菜谱</p><h1>先预览，再保存成你的版本</h1><p>AI 只能创建新的个人版本，永远不会覆盖原食谱；不安全或不完整的结果不会开放保存。</p></header><section className="kitchen-panel"><h2>告诉小厨你的调整</h2>{providers.isPending ? <p>正在读取模型配置…</p> : providers.data?.length === 0 ? <p>还没有可用文本模型。<Link to="/settings/providers">去配置 DeepSeek、Qwen 或兼容模型</Link></p> : <><label>模型<select aria-label="文本模型" onChange={(event) => setProviderId(event.target.value)} value={selectedProvider}>{providers.data?.map((provider: ProviderProfile) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelId}</option>)}</select></label><div className="inline-fields"><label>目标份数<input inputMode="decimal" onChange={(event) => setServings(event.target.value)} placeholder="保持不变" value={servings} /></label></div><div className="check-grid"><label><input checked={lessOil} onChange={(event) => setLessOil(event.target.checked)} type="checkbox" />少油</label><label><input checked={lessSalt} onChange={(event) => setLessSalt(event.target.checked)} type="checkbox" />少盐</label><label><input checked={noSugar} onChange={(event) => setNoSugar(event.target.checked)} type="checkbox" />不加糖</label></div><label>其他要求<textarea maxLength={2000} onChange={(event) => setCustomRequirements(event.target.value)} placeholder="例如：没有牛奶，想保留浓郁口感" value={customRequirements} /></label><button disabled={pending} onClick={() => { void generate() }} type="button">{pending ? '正在生成安全预览…' : '生成改菜谱预览'}</button></>}</section>{error !== undefined && <p className={preview === undefined ? 'form-error' : 'kitchen-notice'} role="status">{error}</p>}{preview !== undefined && <VariantPreview onConfirm={() => { void confirm() }} pending={pending} preview={preview} />}</section>
}
