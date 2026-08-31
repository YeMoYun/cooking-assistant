import { favoriteMutationResultSchema } from '@xiaochu/shared'
import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../../lib/api-client'

export type FavoriteButtonProps = Readonly<{
  favorite: boolean
  onFavoriteChange: (favorite: boolean) => void
  recipeId: string
}>

type FavoriteState = 'error' | 'idle' | 'loading' | 'success'

export const FavoriteButton = ({
  favorite: initialFavorite,
  onFavoriteChange,
  recipeId,
}: FavoriteButtonProps) => {
  const [favorite, setFavorite] = useState(initialFavorite)
  const [state, setState] = useState<FavoriteState>('idle')
  const successTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    setFavorite(initialFavorite)
    setState('idle')
  }, [initialFavorite, recipeId])

  useEffect(() => () => {
    if (successTimer.current !== undefined) {
      window.clearTimeout(successTimer.current)
    }
  }, [])

  const toggleFavorite = async (): Promise<void> => {
    if (state === 'loading') {
      return
    }
    const previous = favorite
    const next = !previous
    setFavorite(next)
    setState('loading')

    try {
      const payload = await apiClient.request<unknown>(
        `/api/favorites/${encodeURIComponent(recipeId)}`,
        {
          method: next ? 'PUT' : 'DELETE',
          signal: new AbortController().signal,
        },
      )
      const result = favoriteMutationResultSchema.parse(payload)
      if (result.recipeId !== recipeId) {
        throw new Error('Favorite response recipe mismatch')
      }
      setFavorite(result.favorite)
      onFavoriteChange(result.favorite)
      setState('success')
      if (successTimer.current !== undefined) {
        window.clearTimeout(successTimer.current)
      }
      successTimer.current = window.setTimeout(() => setState('idle'), 1_200)
    } catch {
      setFavorite(previous)
      onFavoriteChange(previous)
      setState('error')
    }
  }

  return (
    <div className="favorite-control">
      <button
        aria-pressed={favorite}
        className="favorite-button"
        data-state={state}
        disabled={state === 'loading'}
        onClick={() => { void toggleFavorite() }}
        type="button"
      >
        <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
          <path d="M12 20.5 4.6 13.3A5.2 5.2 0 0 1 12 5.9a5.2 5.2 0 0 1 7.4 7.4Z" />
        </svg>
        <span>
          {state === 'loading'
            ? '正在保存'
            : favorite
              ? '已收藏'
              : '收藏'}
        </span>
      </button>
      {state === 'error' && (
        <p className="favorite-control__error" role="alert">
          收藏状态未保存，请确认本地服务已启动后重试。
        </p>
      )}
    </div>
  )
}
