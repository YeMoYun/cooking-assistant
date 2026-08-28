import type { RecipeDifficulty, RecipeTier } from '@xiaochu/shared'
import type { RecipeSearchFilters } from './useRecipeSearch'

export type RecipeFiltersProps = Readonly<{
  filters: RecipeSearchFilters
  onChange: (filters: RecipeSearchFilters) => void
}>

const readDifficulty = (value: string): RecipeDifficulty | undefined => (
  value === 'easy' || value === 'medium' || value === 'hard'
    ? value
    : undefined
)

const readTier = (value: string): RecipeTier | undefined => (
  value === 'standard' || value === 'video' || value === 'detailed'
    ? value
    : undefined
)

const readMinutes = (value: string): number | undefined => {
  const minutes = Number(value)
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : undefined
}

export const RecipeFilters = ({ filters, onChange }: RecipeFiltersProps) => (
  <fieldset className="recipe-filters">
    <legend>筛选食谱</legend>

    <label className="recipe-filter">
      <span>用时</span>
      <select
        aria-label="按用时筛选"
        onChange={(event) => {
          const maxMinutes = readMinutes(event.currentTarget.value)
          const next = { ...filters }
          if (maxMinutes === undefined) {
            delete next.maxMinutes
          } else {
            next.maxMinutes = maxMinutes
          }
          onChange(next)
        }}
        value={filters.maxMinutes ?? ''}
      >
        <option value="">不限用时</option>
        <option value="15">15 分钟内</option>
        <option value="30">30 分钟内</option>
        <option value="60">60 分钟内</option>
      </select>
    </label>

    <label className="recipe-filter">
      <span>难度</span>
      <select
        aria-label="按难度筛选"
        onChange={(event) => {
          const difficulty = readDifficulty(event.currentTarget.value)
          const next = { ...filters }
          if (difficulty === undefined) {
            delete next.difficulty
          } else {
            next.difficulty = difficulty
          }
          onChange(next)
        }}
        value={filters.difficulty ?? ''}
      >
        <option value="">不限难度</option>
        <option value="easy">简单</option>
        <option value="medium">适中</option>
        <option value="hard">有挑战</option>
      </select>
    </label>

    <label className="recipe-filter">
      <span>教程</span>
      <select
        aria-label="按教程层级筛选"
        onChange={(event) => {
          const tier = readTier(event.currentTarget.value)
          const next = { ...filters }
          if (tier === undefined) {
            delete next.tier
          } else {
            next.tier = tier
          }
          onChange(next)
        }}
        value={filters.tier ?? ''}
      >
        <option value="">全部教程</option>
        <option value="standard">标准教程</option>
        <option value="video">视频教程</option>
        <option value="detailed">超详细教程</option>
      </select>
    </label>

    <label className="recipe-filter">
      <span>口味</span>
      <select
        aria-label="按口味筛选"
        onChange={(event) => {
          const next = { ...filters }
          if (event.currentTarget.value === '') {
            delete next.taste
          } else {
            next.taste = event.currentTarget.value
          }
          onChange(next)
        }}
        value={filters.taste ?? ''}
      >
        <option value="">不限口味</option>
        <option value="清淡">清淡</option>
        <option value="酸甜">酸甜</option>
        <option value="咸鲜">咸鲜</option>
        <option value="香辣">香辣</option>
      </select>
    </label>

    <label className="recipe-filter">
      <span>技法</span>
      <select
        aria-label="按主要技法筛选"
        onChange={(event) => {
          const next = { ...filters }
          if (event.currentTarget.value === '') {
            delete next.technique
          } else {
            next.technique = event.currentTarget.value
          }
          onChange(next)
        }}
        value={filters.technique ?? ''}
      >
        <option value="">不限技法</option>
        <option value="炒">炒</option>
        <option value="蒸">蒸</option>
        <option value="煮">煮</option>
        <option value="炖">炖</option>
        <option value="拌">拌</option>
        <option value="烤">烤</option>
      </select>
    </label>
  </fieldset>
)
