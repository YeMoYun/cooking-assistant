import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { RecipeCard } from './RecipeCard'
import { RecipeFilters } from './RecipeFilters'
import { RecipeSearchBar } from './RecipeSearchBar'
import {
  recipeSearchQueryRoot,
  useRecipeSearch,
  type RecipeSearchFilters,
} from './useRecipeSearch'
import './recipe-catalog.css'

const EMPTY_FILTERS: RecipeSearchFilters = Object.freeze({})

const hasFilters = (filters: RecipeSearchFilters): boolean => (
  filters.difficulty !== undefined
  || filters.maxMinutes !== undefined
  || filters.taste !== undefined
  || filters.technique !== undefined
  || filters.tier !== undefined
)

const CatalogSkeleton = () => (
  <div aria-label="正在加载食谱" className="catalog-grid" role="status">
    {Array.from({ length: 10 }, (_, index) => (
      <span aria-hidden="true" className="catalog-skeleton" key={index}>
        <span className="catalog-skeleton__media" />
        <span className="catalog-skeleton__line catalog-skeleton__line--title" />
        <span className="catalog-skeleton__line" />
        <span className="catalog-skeleton__line catalog-skeleton__line--short" />
      </span>
    ))}
  </div>
)

type CatalogStateProps = Readonly<{
  actionLabel: string
  description: string
  heading: string
  onAction: () => void
}>

const CatalogState = ({
  actionLabel,
  description,
  heading,
  onAction,
}: CatalogStateProps) => (
  <section className="catalog-state" role="status">
    <strong>{heading}</strong>
    <p>{description}</p>
    <button onClick={onAction} type="button">{actionLabel}</button>
  </section>
)

export const RecipeCatalogPage = () => {
  const queryClient = useQueryClient()
  const [draftQuery, setDraftQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [filters, setFilters] = useState<RecipeSearchFilters>(EMPTY_FILTERS)
  const [searchSession, setSearchSession] = useState(0)
  const loadMoreTarget = useRef<HTMLDivElement>(null)
  const intersectionLoadLocked = useRef(false)

  const cancelActiveSearch = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: recipeSearchQueryRoot })
  }, [queryClient])

  const submitQuery = useCallback((value: string, force = false) => {
    const normalized = value.trim()
    if (!force && normalized === submittedQuery) {
      return
    }
    cancelActiveSearch()
    setSubmittedQuery(normalized)
    setSearchSession((session) => session + 1)
  }, [cancelActiveSearch, submittedQuery])

  useEffect(() => {
    if (draftQuery.trim() === submittedQuery) {
      return undefined
    }
    const debounceTimer = window.setTimeout(() => {
      submitQuery(draftQuery)
    }, 250)
    return () => window.clearTimeout(debounceTimer)
  }, [draftQuery, submitQuery, submittedQuery])

  const handleDraftChange = useCallback((value: string) => {
    cancelActiveSearch()
    setDraftQuery(value)
  }, [cancelActiveSearch])

  const handleFiltersChange = useCallback((next: RecipeSearchFilters) => {
    cancelActiveSearch()
    setFilters(next)
    setSearchSession((session) => session + 1)
  }, [cancelActiveSearch])

  const resetSearch = useCallback(() => {
    cancelActiveSearch()
    setDraftQuery('')
    setSubmittedQuery('')
    setFilters(EMPTY_FILTERS)
    setSearchSession((session) => session + 1)
  }, [cancelActiveSearch])

  const search = useRecipeSearch({
    filters,
    query: submittedQuery,
    searchSession,
  })

  useEffect(() => {
    const target = loadMoreTarget.current
    if (
      target === null
      || !search.hasNextPage
      || search.catalogRetryRequired
      || typeof IntersectionObserver === 'undefined'
    ) {
      return undefined
    }

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined || !entry.isIntersecting) {
        intersectionLoadLocked.current = false
        return
      }
      if (
        intersectionLoadLocked.current
        || search.isFetchingNextPage
      ) {
        return
      }
      intersectionLoadLocked.current = true
      void search.fetchNextPage()
    }, { rootMargin: '0px 0px 240px' })

    observer.observe(target)
    return () => observer.disconnect()
  }, [
    search.catalogRetryRequired,
    search.fetchNextPage,
    search.hasNextPage,
    search.isFetchingNextPage,
  ])

  const showInitialLoading = search.isPending && search.recipes.length === 0
  const showInitialError = search.isError
    && search.recipes.length === 0
    && !search.catalogRetryRequired
  const showEmpty = search.isSuccess && search.recipes.length === 0
  const hasActiveSearch = submittedQuery !== '' || hasFilters(filters)

  return (
    <div className="page recipe-catalog-page">
      <section className="catalog-hero">
        <div className="catalog-hero__copy">
          <span>本地食谱库</span>
          <h1>找一道今天能做好的菜</h1>
          <p>先用简要信息挑选，点开后再看完整用量和详细步骤。</p>
        </div>
        <RecipeSearchBar
          onChange={handleDraftChange}
          onSubmit={(value) => submitQuery(value, true)}
          value={draftQuery}
        />
      </section>

      <RecipeFilters filters={filters} onChange={handleFiltersChange} />

      {search.catalogNotice !== undefined && (
        <p aria-live="polite" className="catalog-notice" role="status">
          {search.catalogNotice}
        </p>
      )}

      {search.catalogRetryRequired ? (
        <CatalogState
          actionLabel="重新加载"
          description="为避免反复刷新，已暂停自动加载。点击后会从第一页重新获取当前搜索。"
          heading="菜谱库再次发生了更新"
          onAction={search.retryCatalog}
        />
      ) : showInitialLoading ? (
        <CatalogSkeleton />
      ) : showInitialError ? (
        <CatalogState
          actionLabel="重试"
          description="本地服务暂时没有返回食谱，请确认服务已启动后重试。"
          heading="食谱加载失败"
          onAction={() => { void search.refetch() }}
        />
      ) : showEmpty ? (
        <CatalogState
          actionLabel={hasActiveSearch ? '清空搜索与筛选' : '重新加载'}
          description={hasActiveSearch
            ? '换一个菜名、食材或口味，也可以放宽用时和难度。'
            : '本地食谱库暂时没有可展示的内容。'}
          heading="没有找到合适的食谱"
          onAction={hasActiveSearch
            ? resetSearch
            : () => { void search.refetch() }}
        />
      ) : (
        <>
          <div className="catalog-results-heading">
            <p aria-live="polite">
              已加载 <strong>{search.recipes.length}</strong> 道食谱
            </p>
            {hasActiveSearch && (
              <button onClick={resetSearch} type="button">清空条件</button>
            )}
          </div>

          <section aria-label="食谱列表" className="catalog-grid">
            {search.recipes.map((recipe) => (
              <RecipeCard key={recipe.id} recipe={recipe} />
            ))}
          </section>

          {search.hasNextPage && (
            <div className="catalog-load-more" ref={loadMoreTarget}>
              {search.isFetchNextPageError ? (
                <>
                  <span role="alert">继续加载失败，当前结果仍可浏览。</span>
                  <button
                    onClick={() => { void search.fetchNextPage() }}
                    type="button"
                  >
                    重试加载
                  </button>
                </>
              ) : (
                <button
                  disabled={search.isFetchingNextPage}
                  onClick={() => { void search.fetchNextPage() }}
                  type="button"
                >
                  {search.isFetchingNextPage ? '正在加载更多…' : '加载更多'}
                </button>
              )}
            </div>
          )}

          {!search.hasNextPage && search.recipes.length > 0 && (
            <p className="catalog-end">已经看到当前条件下的全部食谱</p>
          )}
        </>
      )}
    </div>
  )
}
