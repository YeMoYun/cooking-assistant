import {
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  recipePageSchema,
  type RecipeDifficulty,
  type RecipePage,
  type RecipeTier,
} from '@xiaochu/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient, ApiClientError } from '../../lib/api-client'

export const recipeSearchQueryRoot = ['recipes', 'catalog'] as const

export type RecipeSearchFilters = Readonly<{
  difficulty?: RecipeDifficulty
  maxMinutes?: number
  taste?: string
  technique?: string
  tier?: RecipeTier
}>

export type RecipeSearchRequest = Readonly<{
  filters: RecipeSearchFilters
  query: string
  searchSession: number
}>

type CatalogRecoveryStatus =
  | 'idle'
  | 'refreshing'
  | 'refreshed'
  | 'retry-required'

type CatalogRecoveryState = Readonly<{
  identity: string
  status: CatalogRecoveryStatus
}>

const PAGE_SIZE = 20

const buildSearchIdentity = (
  query: string,
  filters: RecipeSearchFilters,
): string => JSON.stringify({
  query: query.trim(),
  difficulty: filters.difficulty ?? null,
  maxMinutes: filters.maxMinutes ?? null,
  taste: filters.taste?.trim() || null,
  technique: filters.technique?.trim() || null,
  tier: filters.tier ?? null,
})

const buildSearchPath = (
  query: string,
  filters: RecipeSearchFilters,
  cursor: string | undefined,
): string => {
  const parameters = new URLSearchParams()
  const normalizedQuery = query.trim()
  if (normalizedQuery !== '') {
    parameters.set('q', normalizedQuery)
  }
  if (filters.difficulty !== undefined) {
    parameters.set('difficulty', filters.difficulty)
  }
  if (filters.maxMinutes !== undefined) {
    parameters.set('maxMinutes', String(filters.maxMinutes))
  }
  if (filters.taste?.trim()) {
    parameters.set('taste', filters.taste.trim())
  }
  if (filters.technique?.trim()) {
    parameters.set('technique', filters.technique.trim())
  }
  if (filters.tier !== undefined) {
    parameters.set('tier', filters.tier)
  }
  if (cursor !== undefined) {
    parameters.set('cursor', cursor)
  }
  parameters.set('limit', String(PAGE_SIZE))
  return `/api/recipes?${parameters.toString()}`
}

const fetchRecipePage = async (
  query: string,
  filters: RecipeSearchFilters,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<RecipePage> => {
  const payload = await apiClient.request<unknown>(
    buildSearchPath(query, filters, cursor),
    { method: 'GET', signal },
  )
  return recipePageSchema.parse(payload)
}

const isCatalogChangedError = (error: unknown): boolean => (
  error instanceof ApiClientError
  && error.statusCode === 409
  && error.code === 'catalog_changed'
)

export const useRecipeSearch = ({
  filters,
  query,
  searchSession,
}: RecipeSearchRequest) => {
  const queryClient = useQueryClient()
  const identity = useMemo(
    () => buildSearchIdentity(query, filters),
    [filters, query],
  )
  const [catalogRestart, setCatalogRestart] = useState(0)
  const [recovery, setRecovery] = useState<CatalogRecoveryState>({
    identity,
    status: 'idle',
  })
  const restartGuard = useRef({
    automaticRestartUsed: false,
    identity,
  })

  if (restartGuard.current.identity !== identity) {
    restartGuard.current = {
      automaticRestartUsed: false,
      identity,
    }
  }

  const queryKey = useMemo(
    () => [
      ...recipeSearchQueryRoot,
      identity,
      searchSession,
      catalogRestart,
    ] as const,
    [catalogRestart, identity, searchSession],
  )

  const result = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchRecipePage(
      query,
      filters,
      pageParam,
      signal,
    ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: (failureCount, error) => (
      !isCatalogChangedError(error) && failureCount < 1
    ),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  })

  useEffect(() => {
    if (!isCatalogChangedError(result.error)) {
      return
    }

    const currentGuard = restartGuard.current
    if (currentGuard.identity !== identity) {
      return
    }

    if (currentGuard.automaticRestartUsed) {
      setRecovery({ identity, status: 'retry-required' })
      return
    }

    currentGuard.automaticRestartUsed = true
    setRecovery({ identity, status: 'refreshing' })
    const staleQueryKey = queryKey
    void queryClient.cancelQueries({
      exact: true,
      queryKey: staleQueryKey,
    }).then(() => {
      queryClient.removeQueries({ exact: true, queryKey: staleQueryKey })
      if (restartGuard.current.identity === identity) {
        setCatalogRestart((value) => value + 1)
      }
    })
  }, [identity, queryClient, queryKey, result.error])

  const activeRecoveryStatus = recovery.identity === identity
    ? recovery.status
    : 'idle'

  useEffect(() => {
    if (activeRecoveryStatus === 'refreshing' && result.isSuccess) {
      setRecovery({ identity, status: 'refreshed' })
    }
  }, [activeRecoveryStatus, identity, result.isSuccess])

  const retryCatalog = useCallback(() => {
    restartGuard.current = {
      automaticRestartUsed: true,
      identity,
    }
    setRecovery({ identity, status: 'refreshing' })
    const staleQueryKey = queryKey
    void queryClient.cancelQueries({
      exact: true,
      queryKey: staleQueryKey,
    }).then(() => {
      queryClient.removeQueries({ exact: true, queryKey: staleQueryKey })
      if (restartGuard.current.identity === identity) {
        setCatalogRestart((value) => value + 1)
      }
    })
  }, [identity, queryClient, queryKey])

  const recipes = useMemo(() => {
    const seen = new Set<string>()
    return (result.data?.pages ?? []).flatMap((page) => page.items).filter(
      (recipe) => {
        if (seen.has(recipe.id)) {
          return false
        }
        seen.add(recipe.id)
        return true
      },
    )
  }, [result.data])

  return {
    ...result,
    catalogNotice: activeRecoveryStatus === 'refreshing'
      || activeRecoveryStatus === 'refreshed'
      ? '菜谱库已更新，结果已刷新'
      : undefined,
    catalogRetryRequired: activeRecoveryStatus === 'retry-required',
    recipes,
    retryCatalog,
  }
}
