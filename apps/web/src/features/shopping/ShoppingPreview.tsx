import type { PendingActionPreview } from '@xiaochu/shared'

const categoryLabels: Record<string, string> = { produce: '蔬果', meat_egg_dairy: '肉蛋奶', staple: '主食', seasoning: '调味', other: '其他' }

export const ShoppingPreview = ({
  onConfirm,
  pending,
  preview,
}: {
  readonly onConfirm: () => void
  readonly pending: boolean
  readonly preview: Extract<PendingActionPreview, { readonly kind: 'shopping_items' }>
}) => <section className="kitchen-panel shopping-preview"><div className="section-title"><div><p className="eyebrow">生成预览</p><h2>{preview.title}</h2></div><span>到期：{new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}</span></div><p>下列食材已经按单位和冰箱库存合并；确认后才写入购物清单。</p><ul className="preview-list">{preview.preview.items.map((item) => <li key={`${item.name}-${item.unit}`}><span className="category-pill">{categoryLabels[item.category]}</span><strong>{item.name}</strong><span>{item.quantity} {item.unit}</span><small>{item.sources.join('、')}{item.requiresReview ? ' · 请核对单位' : ''}</small></li>)}</ul><button disabled={pending} onClick={onConfirm} type="button">{pending ? '正在写入清单…' : '确认加入购物清单'}</button></section>
