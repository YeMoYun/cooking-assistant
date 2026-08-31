import { unitValues, type RecognitionPreview } from '@xiaochu/shared'
import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiClientError, apiClient } from '../../lib/api-client'

type EditableCandidate = {
  readonly key: string
  readonly confidence: number
  readonly reasons: readonly string[]
  category: 'produce' | 'meat_egg_dairy' | 'staple' | 'seasoning' | 'other'
  name: string
  quantity: string
  unit: string
}

const reasonLabels: Record<string, string> = {
  low_confidence: '模型把握不高',
  ingredient_mapping_ambiguous: '食材匹配有歧义',
  ingredient_unmapped: '尚未匹配到标准食材',
  unknown_unit: '单位需要你确认',
}

const asCandidates = (preview: RecognitionPreview): EditableCandidate[] => preview.candidates.map((candidate, index) => ({
  key: `${index}-${candidate.name}`,
  confidence: candidate.confidence,
  reasons: candidate.reasons,
  category: candidate.category,
  name: candidate.name,
  quantity: String(candidate.quantity),
  unit: candidate.unit,
}))

export const RecognitionConfirmPage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const preview = location.state as RecognitionPreview | null
  const [items, setItems] = useState(() => preview === null ? [] : asCandidates(preview))
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState(false)
  const valid = useMemo(() => items.length > 0 && items.every((item) => (
    item.name.trim().length > 0
    && Number.isFinite(Number(item.quantity))
    && Number(item.quantity) > 0
    && (unitValues as readonly string[]).includes(item.unit)
  )), [items])

  if (preview === null) {
    return (
      <section className="page kitchen-page"><h1>没有可确认的识别结果</h1><p>请先从冰箱页选择一张照片，或直接手动添加食材。</p><Link to="/inventory">回到冰箱</Link></section>
    )
  }

  const update = (key: string, field: keyof EditableCandidate, value: string): void => {
    setItems((current) => current.map((item) => item.key === key ? { ...item, [field]: value } : item))
  }
  const confirm = async (): Promise<void> => {
    if (!valid) return
    setError(undefined)
    setPending(true)
    try {
      await apiClient.request(`/api/vision/${encodeURIComponent(preview.recognitionId)}/confirm`, {
        method: 'POST',
        body: { items: items.map(({ category, name, quantity, unit }) => ({ category, name: name.trim(), quantity: Number(quantity), unit })) },
        signal: new AbortController().signal,
      })
      navigate('/inventory', { replace: true, state: { notice: '已把你确认的食材加入冰箱' } })
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : '确认失败，请检查网络后重试')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="page kitchen-page">
      <Link className="detail-back-link" to="/inventory">← 返回冰箱</Link>
      <header className="page-heading"><p className="eyebrow">确认后才入库</p><h1>检查识别到的食材</h1><p>有效到 {new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}；你提交的内容才是最终入库内容。</p></header>
      <div className="candidate-list">
        {items.map((item) => <article className="candidate-card" key={item.key}>
          <div className="candidate-card__header"><strong>{Math.round(item.confidence * 100)}% 置信度</strong><button onClick={() => setItems((current) => current.filter((candidate) => candidate.key !== item.key))} type="button">删除</button></div>
          {item.reasons.length > 0 && <p className="candidate-card__reasons">{item.reasons.map((reason) => reasonLabels[reason] ?? reason).join(' · ')}</p>}
          <div className="inline-fields"><input aria-label="食材名称" onChange={(event) => update(item.key, 'name', event.target.value)} value={item.name} /><input aria-label="数量" inputMode="decimal" onChange={(event) => update(item.key, 'quantity', event.target.value)} value={item.quantity} /><select aria-label="单位" onChange={(event) => update(item.key, 'unit', event.target.value)} value={item.unit}>{unitValues.map((unit) => <option key={unit}>{unit}</option>)}</select></div>
        </article>)}
      </div>
      {error !== undefined && <p className="form-error" role="alert">{error}</p>}
      <div className="action-row"><Link to="/inventory">取消，不写入</Link><button disabled={!valid || pending} onClick={() => { void confirm() }} type="button">{pending ? '正在确认…' : '确认加入冰箱'}</button></div>
    </section>
  )
}
