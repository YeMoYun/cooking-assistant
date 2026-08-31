import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type PendingActionPreview, type ShoppingSnapshot, unitValues } from '@xiaochu/shared'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiClientError, apiClient } from '../../lib/api-client'
import { ShoppingPreview } from './ShoppingPreview'
import '../inventory/kitchen.css'

const categories = ['produce', 'meat_egg_dairy', 'staple', 'seasoning', 'other'] as const
const categoryLabels: Record<(typeof categories)[number], string> = { produce: '蔬果', meat_egg_dairy: '肉蛋奶', staple: '主食', seasoning: '调味', other: '其他' }

export const ShoppingListPage = () => {
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const [recipeId, setRecipeId] = useState(params.get('recipeId') ?? '')
  const [servings, setServings] = useState('2')
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState<(typeof unitValues)[number]>('g')
  const [category, setCategory] = useState<(typeof categories)[number]>('produce')
  const [preview, setPreview] = useState<Extract<PendingActionPreview, { kind: 'shopping_items' }> | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState(false)
  const snapshot = useQuery({ queryKey: ['shopping'], queryFn: ({ signal }) => apiClient.request<ShoppingSnapshot>('/api/shopping', { method: 'GET', signal }) })
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['shopping'] }) }
  const add = async (): Promise<void> => { try { await apiClient.request('/api/shopping', { method: 'POST', body: { itemId: crypto.randomUUID(), name: name.trim(), quantity: Number(quantity), unit, category }, signal: new AbortController().signal }); setName(''); setQuantity(''); refresh() } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : '无法添加购物项') } }
  const toggle = async (id: string, version: number, checked: boolean): Promise<void> => { await apiClient.request(`/api/shopping/${encodeURIComponent(id)}`, { method: 'PATCH', body: { expectedVersion: version, checked }, signal: new AbortController().signal }); refresh() }
  const remove = async (id: string, version: number): Promise<void> => { await apiClient.request(`/api/shopping/${encodeURIComponent(id)}?version=${version}`, { method: 'DELETE', signal: new AbortController().signal }); refresh() }
  const generate = async (): Promise<void> => { if (!recipeId.trim() || !(Number(servings) > 0)) return; try { const result = await apiClient.request<PendingActionPreview>('/api/shopping/generate-preview', { method: 'POST', body: { recipes: [{ recipeId: recipeId.trim(), servings: Number(servings) }] }, signal: new AbortController().signal }); if (result.kind === 'shopping_items') setPreview(result) } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : '生成预览失败，可继续手动添加') } }
  const confirm = async (): Promise<void> => { if (preview === undefined) return; setPending(true); try { await apiClient.request('/api/shopping/generate-confirm', { method: 'POST', body: { pendingActionId: preview.pendingActionId }, signal: new AbortController().signal }); setPreview(undefined); refresh() } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : '清单已变化，请重新生成') } finally { setPending(false) } }
  const copyToInventory = async (id: string): Promise<void> => { try { await apiClient.request(`/api/shopping/${encodeURIComponent(id)}/add-to-inventory`, { method: 'POST', body: { inventoryItemId: crypto.randomUUID() }, signal: new AbortController().signal }); refresh() } catch (caught) { setError(caught instanceof ApiClientError ? caught.message : '请先勾选这个购物项再加入冰箱') } }
  return <section className="page kitchen-page"><header className="page-heading"><p className="eyebrow">购物清单</p><h1>缺什么，一次买齐</h1><p>生成前先做预览；购物项不会自动进入冰箱，只有你勾选后主动加入才会写入。</p></header><section className="kitchen-panel"><h2>从食谱生成</h2><div className="inline-fields"><input aria-label="食谱 ID" onChange={(event) => setRecipeId(event.target.value)} placeholder="食谱 ID" value={recipeId} /><input aria-label="份数" inputMode="decimal" onChange={(event) => setServings(event.target.value)} value={servings} /><button onClick={() => { void generate() }} type="button">生成预览</button></div><p className="hint">可以从具体食谱页直接带入，也可以在此粘贴食谱 ID。</p></section>{preview !== undefined && <ShoppingPreview onConfirm={() => { void confirm() }} pending={pending} preview={preview} />}<section className="kitchen-panel"><h2>手动添加</h2><div className="inline-fields"><input aria-label="购物食材名称" onChange={(event) => setName(event.target.value)} placeholder="例如：番茄" value={name} /><input aria-label="购物数量" inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} placeholder="数量" value={quantity} /><select aria-label="购物单位" onChange={(event) => setUnit(event.target.value as typeof unit)} value={unit}>{unitValues.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="购物类别" onChange={(event) => setCategory(event.target.value as typeof category)} value={category}>{categories.map((value) => <option key={value} value={value}>{categoryLabels[value]}</option>)}</select><button disabled={!name.trim() || !(Number(quantity) > 0)} onClick={() => { void add() }} type="button">添加</button></div></section>{error !== undefined && <p className="form-error" role="alert">{error}</p>}<section className="kitchen-panel"><h2>待买清单</h2>{snapshot.isPending ? <p>正在读取清单…</p> : snapshot.data?.items.length === 0 ? <p>还没有购物项。<Link to="/recipes">去找一道想做的菜</Link></p> : <ul className="kitchen-list">{snapshot.data?.items.map((item) => <li key={item.id}><label className="shopping-check"><input checked={item.checked} onChange={(event) => { void toggle(item.id, item.version, event.target.checked) }} type="checkbox" /><span><strong>{item.name}</strong><small>{item.quantity} {item.unit} · {categoryLabels[item.category]} · {item.sources.join('、')}{item.requiresReview ? ' · 请核对' : ''}</small></span></label><span className="list-actions">{item.checked && <button onClick={() => { void copyToInventory(item.id) }} type="button">放入冰箱</button>}<button onClick={() => { void remove(item.id, item.version) }} type="button">删除</button></span></li>)}</ul>}</section></section>
}
