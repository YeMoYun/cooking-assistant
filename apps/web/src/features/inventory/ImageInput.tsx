import { useRef, useState } from 'react'
import { ApiClientError, apiClient } from '../../lib/api-client'
import type { RecognitionPreview } from '@xiaochu/shared'

export const ImageInput = ({
  onRecognized,
}: {
  readonly onRecognized: (preview: RecognitionPreview) => void
}) => {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState(false)

  const recognize = async (): Promise<void> => {
    const file = input.current?.files?.[0]
    if (file === undefined) {
      setError('请先选择一张冰箱或食材照片')
      return
    }
    setError(undefined)
    setPending(true)
    const form = new FormData()
    form.set('image', file)
    try {
      const preview = await apiClient.request<RecognitionPreview>('/api/vision/recognize', {
        method: 'POST',
        body: form,
        signal: new AbortController().signal,
      })
      onRecognized(preview)
    } catch (caught) {
      setError(caught instanceof ApiClientError
        ? caught.message
        : '照片暂时无法识别，你仍可手动添加食材')
    } finally {
      setPending(false)
      if (input.current !== null) input.current.value = ''
    }
  }

  return (
    <section className="kitchen-panel inventory-photo">
      <div>
        <p className="eyebrow">冰箱识别</p>
        <h2>拍照后，先由你确认</h2>
        <p>识别结果不会自动写入冰箱；你可以改名称、数量、单位或删除任何一项。</p>
      </div>
      <label className="file-control">
        <span>选择 JPEG、PNG 或 WebP 图片（最多 10 MiB）</span>
        <input accept="image/jpeg,image/png,image/webp" capture="environment" ref={input} type="file" />
      </label>
      {error !== undefined && <p className="form-error" role="alert">{error}</p>}
      <button disabled={pending} onClick={() => { void recognize() }} type="button">
        {pending ? '正在识别…' : '识别照片'}
      </button>
    </section>
  )
}
