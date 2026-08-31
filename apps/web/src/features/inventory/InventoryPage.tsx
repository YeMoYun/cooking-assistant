import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { unitValues, type InventorySnapshot, type RecipeMatchPage } from '@xiaochu/shared'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiClientError, apiClient } from '../../lib/api-client'
import { ImageInput } from './ImageInput'
import './kitchen.css'

const categories = ['produce', 'meat_egg_dairy', 'staple', 'seasoning', 'other'] as const
const categoryLabel: Record<(typeof categories)[number], string> = { produce: '蔬果', meat_egg_dairy: '肉蛋奶', staple: '主食', seasoning: '调味', other: '其他' }
const snapshotKey = ['inventory'] as const

export const InventoryPage = () => {
  const client = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState<(typeof unitValues)[number]>('g')
  const [category, setCategory] = useState<(typeof categories)[number]>('produce')
  const [error, setError] = useState<string | undefined>()
  const [matches, setMatches] = useState<RecipeMatchPage | undefined>()
  const inventory = useQuery({ queryKey: snapshotKey, queryFn: ({ signal }) => apiClient.request<InventorySnapshot>('/api/inventory', { method: 'GET', signal }) })
  const refresh = (): void => { void client.invalidateQueries({ queryKey: snapshotKey }) }
  const manual = useMutation({
    mutationFn: () => apiClient.request('/api/inventory', { method: 'POST', body: { itemId: crypto.randomUUID(), name: name.trim(), quantity: Number(quantity), unit, category, source: 'manual' }, signal: new AbortController().signal }),
    onSuccess: () => { setName(''); setQuantity(''); setError(undefined); refresh() },
    onError: (caught) => setError(caught instanceof ApiClientError ? caught.message : '无法添加食材'),
  })
  const remove = async (id: string, version: number): Promise<void> => { await apiClient.request(`/api/inventory/${encodeURIComponent(id)}?version=${version}`, { method: 'DELETE', signal: new AbortController().signal }); refresh() }
  const findRecipes = async (): Promise<void> => { setMatches(await apiClient.request<RecipeMatchPage>('/api/inventory/recipe-matches?mode=best&limit=8', { method: 'GET', signal: new AbortController().signal })) }

  return <section className="page kitchen-page"><header className="page-heading"><p className="eyebrow">我的冰箱</p><h1>把手边食材变成可做的菜</h1><p>{typeof location.state === 'object' && location.state !== null && 'notice' in location.state ? String(location.state.notice) : '拍照识别必须经过你的确认；也可以完全手动管理。'}</p></header>
    <ImageInput onRecognized={(preview) => navigate('/inventory/recognition', { state: preview })} />
    <section className="kitchen-panel"><h2>手动添加食材</h2><div className="inline-fields"><input aria-label="食材名称" onChange={(event) => setName(event.target.value)} placeholder="例如：鸡蛋" value={name} /><input aria-label="数量" inputMode="decimal" onChange={(event) => setQuantity(event.target.value)} placeholder="数量" value={quantity} /><select aria-label="单位" onChange={(event) => setUnit(event.target.value as typeof unit)} value={unit}>{unitValues.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="类别" onChange={(event) => setCategory(event.target.value as typeof category)} value={category}>{categories.map((value) => <option key={value} value={value}>{categoryLabel[value]}</option>)}</select><button disabled={manual.isPending || !name.trim() || !(Number(quantity) > 0)} onClick={() => manual.mutate()} type="button">加入冰箱</button></div>{error !== undefined && <p className="form-error" role="alert">{error}</p>}</section>
    <section className="kitchen-panel"><div className="section-title"><h2>现有食材</h2><button onClick={() => { void findRecipes() }} type="button">用现有食材找菜</button></div>{inventory.isPending ? <p>正在读取冰箱…</p> : inventory.data?.items.length === 0 ? <p>冰箱还是空的，先拍照或手动添加食材。</p> : <ul className="kitchen-list">{inventory.data?.items.map((item) => <li key={item.id}><span><strong>{item.name}</strong><small>{item.quantity} {item.unit} · {categoryLabel[item.category]}</small></span><button onClick={() => { void remove(item.id, item.version) }} type="button">删除</button></li>)}</ul>}</section>
    {matches !== undefined && <section className="kitchen-panel"><h2>现在适合做</h2>{matches.items.length === 0 ? <p>还没有匹配菜谱；继续补充食材或浏览食谱。</p> : <ul className="match-list">{matches.items.map((match) => <li key={match.recipeId}><Link to={`/recipes/${encodeURIComponent(match.recipeId)}`}>{match.title}</Link><span>已覆盖 {match.coveredIngredients}/{match.totalIngredients} 种</span>{match.missingIngredients.length > 0 && <small>还缺：{match.missingIngredients.join('、')}</small>}</li>)}</ul>}</section>}
  </section>
}
