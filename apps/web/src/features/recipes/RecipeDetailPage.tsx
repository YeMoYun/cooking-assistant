import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  recipeDetailSchema,
  recipeIdParamsSchema,
  type RecipeDetail,
} from '@xiaochu/shared'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { apiClient, ApiClientError } from '../../lib/api-client'
import { FavoriteButton } from './FavoriteButton'
import { IngredientList } from './IngredientList'
import { RecipeNotes } from './RecipeNotes'
import { RecipeSteps } from './RecipeSteps'
import { VideoTutorial } from './VideoTutorial'
import './recipe-detail.css'

const difficultyLabels = {
  easy: '简单',
  medium: '适中',
  hard: '有挑战',
} as const

const tierLabels = {
  standard: '标准教程',
  video: '视频教程',
  detailed: '超详细教程',
} as const

export const recipeDetailQueryKey = (recipeId: string) => (
  ['recipes', 'detail', recipeId] as const
)

const fetchRecipeDetail = async (
  recipeId: string,
  signal: AbortSignal,
): Promise<RecipeDetail> => {
  const payload = await apiClient.request<unknown>(
    `/api/recipes/${encodeURIComponent(recipeId)}`,
    { method: 'GET', signal },
  )
  return recipeDetailSchema.parse(payload)
}

const DetailSkeleton = () => (
  <div aria-label="正在加载完整食谱" aria-live="polite" className="detail-skeleton" role="status">
    <span className="detail-skeleton__back" />
    <span className="detail-skeleton__title" />
    <span className="detail-skeleton__meta" />
    <span className="detail-skeleton__media" />
    <span className="detail-skeleton__line" />
    <span className="detail-skeleton__line detail-skeleton__line--short" />
  </div>
)

const RecipeCover = ({
  alt,
  title,
  url,
}: {
  readonly alt: string
  readonly title: string
  readonly url: string | null
}) => {
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [url])

  if (url === null || failed) {
    return (
      <div aria-label={`${title}暂无封面`} className="detail-cover detail-cover--placeholder" role="img">
        <span aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className="detail-cover">
      <img
        alt={alt}
        decoding="async"
        fetchPriority="high"
        height="600"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        src={url}
        width="800"
      />
    </div>
  )
}

const DetailError = ({
  notFound,
  onRetry,
}: {
  readonly notFound: boolean
  readonly onRetry: () => void
}) => (
  <section className="detail-state" role={notFound ? 'status' : 'alert'}>
    <h1>{notFound ? '没有找到这道菜' : '完整食谱没有加载出来'}</h1>
    <p>
      {notFound
        ? '它可能已从本地食谱库移除，返回列表可以重新挑一道。'
        : '本地服务没有返回教程。确认服务已启动后再试，已导入的数据不会受影响。'}
    </p>
    {notFound ? (
      <Link to="/recipes">返回食谱列表</Link>
    ) : (
      <button onClick={onRetry} type="button">重新加载食谱</button>
    )}
  </section>
)

export const RecipeDetailPage = () => {
  const params = recipeIdParamsSchema.safeParse(useParams())
  const recipeId = params.success ? params.data.recipeId : ''
  const queryClient = useQueryClient()
  const recordedView = useRef<string | undefined>(undefined)
  const queryKey = recipeDetailQueryKey(recipeId)
  const detail = useQuery({
    enabled: params.success,
    queryKey,
    queryFn: ({ signal }) => fetchRecipeDetail(recipeId, signal),
    retry: (failureCount, error) => (
      !(error instanceof ApiClientError && error.statusCode === 404)
      && failureCount < 1
    ),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (detail.data === undefined || recordedView.current === detail.data.id) {
      return
    }
    recordedView.current = detail.data.id
    void apiClient.request<unknown>(
      `/api/recent-views/${encodeURIComponent(detail.data.id)}`,
      {
        method: 'POST',
        signal: new AbortController().signal,
      },
    ).catch(() => {
      // Recent-view recording is deliberately best-effort and never gates tutorial access.
    })
  }, [detail.data])

  if (!params.success) {
    return <DetailError notFound onRetry={() => undefined} />
  }
  if (detail.isPending) {
    return <DetailSkeleton />
  }
  if (detail.isError || detail.data === undefined) {
    const notFound = detail.error instanceof ApiClientError
      && detail.error.statusCode === 404
      && detail.error.code === 'recipe_not_found'
    return (
      <DetailError
        notFound={notFound}
        onRetry={() => { void detail.refetch() }}
      />
    )
  }

  const recipe = detail.data
  const updateFavorite = (favorite: boolean): void => {
    queryClient.setQueryData<RecipeDetail>(queryKey, (current) => (
      current === undefined
        ? current
        : { ...current, favorite } as RecipeDetail
    ))
  }

  return (
    <article className="page recipe-detail-page">
      <Link className="detail-back-link" to="/recipes">← 返回食谱列表</Link>

      <header className="detail-hero">
        <div className="detail-hero__copy">
          <div className="detail-hero__labels">
            <span>{tierLabels[recipe.tier]}</span>
            {recipe.tastes.map((taste) => <span key={taste}>{taste}</span>)}
          </div>
          <h1>{recipe.title}</h1>
          <p>{recipe.summary}</p>
          <dl className="detail-meta">
            <div><dt>难度</dt><dd>{difficultyLabels[recipe.difficulty]}</dd></div>
            <div><dt>份量</dt><dd>{recipe.servings} 人份</dd></div>
            <div><dt>总用时</dt><dd>{recipe.totalMinutes} 分钟</dd></div>
            <div><dt>备料 / 烹饪</dt><dd>{recipe.prepMinutes} / {recipe.cookMinutes} 分钟</dd></div>
          </dl>
          <FavoriteButton
            favorite={recipe.favorite}
            onFavoriteChange={updateFavorite}
            recipeId={recipe.id}
          />
        </div>
        <RecipeCover
          alt={recipe.cover.alt}
          title={recipe.title}
          url={recipe.cover.url}
        />
      </header>

      <div className="detail-reading-column">
        {recipe.tier !== 'standard' && (
          <VideoTutorial media={recipe.media} recipeTitle={recipe.title} />
        )}

        <IngredientList
          ingredients={recipe.ingredients}
          servings={recipe.servings}
        />
        <RecipeSteps
          detailed={recipe.tier === 'detailed'}
          steps={recipe.steps}
        />

        <nav aria-label="食谱后续操作" className="recipe-actions">
          <Link to={`/recipes/${encodeURIComponent(recipe.id)}/adapt`}>
            用 AI 修改这份菜谱
          </Link>
          <Link to={`/shopping?recipeId=${encodeURIComponent(recipe.id)}`}>
            加入购物清单
          </Link>
        </nav>

        <RecipeNotes initialNotes={recipe.notes} recipeId={recipe.id} />
      </div>
    </article>
  )
}
