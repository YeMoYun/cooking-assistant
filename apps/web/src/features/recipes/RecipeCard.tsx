import { type RecipeCard as RecipeCardData } from '@xiaochu/shared'
import { useState } from 'react'
import { Link } from 'react-router-dom'

export type RecipeCardProps = Readonly<{
  recipe: RecipeCardData
}>

const difficultyLabels = {
  easy: '简单',
  medium: '适中',
  hard: '有挑战',
} as const

const tierLabels = {
  standard: '标准教程',
  video: '视频教程',
  detailed: '超详细',
} as const

const CoverPlaceholder = ({ title }: { readonly title: string }) => (
  <span
    aria-label={`${title}暂无封面`}
    className="catalog-card__placeholder"
    role="img"
  >
    <span aria-hidden="true" className="catalog-card__placeholder-pan">
      <span />
    </span>
  </span>
)

export const RecipeCard = ({ recipe }: RecipeCardProps) => {
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = recipe.coverUrl !== undefined && !imageFailed

  return (
    <Link
      className="catalog-card"
      data-recipe-id={recipe.id}
      to={`/recipes/${encodeURIComponent(recipe.id)}`}
    >
      <span className="catalog-card__media">
        {showImage ? (
          <img
            alt={`${recipe.title}封面`}
            decoding="async"
            loading="lazy"
            onError={() => setImageFailed(true)}
            referrerPolicy="no-referrer"
            src={recipe.coverUrl}
          />
        ) : (
          <CoverPlaceholder title={recipe.title} />
        )}
      </span>

      <span className="catalog-card__body">
        <strong className="catalog-card__title">{recipe.title}</strong>
        <span className="catalog-card__summary">{recipe.summary}</span>
        <span className="catalog-card__meta">
          <span>{recipe.totalMinutes} 分钟</span>
          <span>{difficultyLabels[recipe.difficulty]}</span>
        </span>
        <span className={`catalog-card__tier catalog-card__tier--${recipe.tier}`}>
          {tierLabels[recipe.tier]}
        </span>
      </span>
    </Link>
  )
}
