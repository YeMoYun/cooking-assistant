import type { PendingActionPreview } from '@xiaochu/shared'
import { VariantDiff } from './VariantDiff'

export const VariantPreview = ({ onConfirm, pending, preview }: { readonly onConfirm: () => void; readonly pending: boolean; readonly preview: Extract<PendingActionPreview, { readonly kind: 'recipe_variant' }> }) => <section className="kitchen-panel variant-preview"><p className="eyebrow">生成预览</p><h2>{preview.title}</h2><p>原食谱不会被修改。请看完差异与安全提示后，再保存为你的个人版本。</p><VariantDiff diff={preview.preview} /><button disabled={pending} onClick={onConfirm} type="button">{pending ? '正在保存…' : '保存为我的版本'}</button></section>
