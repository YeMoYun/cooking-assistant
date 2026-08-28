import {
  apiProblemSchema,
  apiSuccessSchema,
  type ApiProblem,
} from '@xiaochu/shared'
import { z } from 'zod'

const bootstrapSchema = z.object({
  capabilities: z.object({
    speechRecognition: z.literal('browser-detect'),
    speechSynthesis: z.literal('browser-detect'),
  }).strict(),
  csrfToken: z.string().min(1),
  sessionExpiresAt: z.iso.datetime(),
}).strict()

export type BootstrapData = z.infer<typeof bootstrapSchema>

type JsonBody = Readonly<Record<string, unknown>> | readonly unknown[]

export type ApiRequestOptions = Omit<
  RequestInit,
  'body' | 'credentials' | 'signal'
> & {
  readonly body?: BodyInit | JsonBody
  readonly signal: AbortSignal
}

export interface ApiClient {
  bootstrap(signal: AbortSignal): Promise<BootstrapData>
  request<T>(path: string, options: ApiRequestOptions): Promise<T>
}

export interface CreateApiClientOptions {
  readonly fetch?: typeof globalThis.fetch
}

export class ApiClientError extends Error {
  readonly code: string
  readonly details?: unknown
  readonly requestId: string
  readonly statusCode: number

  constructor(problem: ApiProblem, statusCode: number) {
    super(problem.error.message)
    this.name = 'ApiClientError'
    this.code = problem.error.code
    this.details = problem.error.details
    this.requestId = problem.error.requestId
    this.statusCode = statusCode
  }
}

const invalidResponseProblem = (): ApiProblem => ({
  error: {
    code: 'invalid_response',
    message: '服务器返回了无法识别的内容',
    requestId: 'client-side',
  },
})

const parseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    throw new ApiClientError(invalidResponseProblem(), response.status)
  }
}

const parseProblem = (payload: unknown, statusCode: number): ApiClientError => {
  const parsed = apiProblemSchema.safeParse(payload)
  return new ApiClientError(
    parsed.success ? parsed.data : invalidResponseProblem(),
    statusCode,
  )
}

const assertApiPath = (path: string): void => {
  if (
    !/^\/api(?:[/?#]|$)/u.test(path)
    || path.startsWith('//')
    || path.includes('\\')
  ) {
    throw new TypeError('API path must be a relative /api URL')
  }

  const parsed = new URL(path, 'http://xiaochu.local')
  if (
    parsed.origin !== 'http://xiaochu.local'
    || !/^\/api(?:\/|$)/u.test(parsed.pathname)
  ) {
    throw new TypeError('API path must be a relative /api URL')
  }
}

const isBodyInit = (body: BodyInit | JsonBody): body is BodyInit => (
  typeof body === 'string'
  || body instanceof Blob
  || body instanceof FormData
  || body instanceof URLSearchParams
  || body instanceof ArrayBuffer
  || ArrayBuffer.isView(body)
)

const prepareBody = (
  body: ApiRequestOptions['body'],
  headers: Headers,
): BodyInit | undefined => {
  if (body === undefined) {
    return undefined
  }
  if (isBodyInit(body)) {
    return body
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return JSON.stringify(body)
}

export const createApiClient = (
  options: CreateApiClientOptions = {},
): ApiClient => {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  let bootstrapPromise: Promise<BootstrapData> | undefined
  let csrfToken: string | undefined

  const bootstrap = (signal: AbortSignal): Promise<BootstrapData> => {
    if (bootstrapPromise !== undefined) {
      return bootstrapPromise
    }

    bootstrapPromise = fetchImpl('/api/bootstrap', {
      credentials: 'same-origin',
      method: 'GET',
      signal,
    }).then(async (response) => {
      const payload = await parseJson(response)
      if (!response.ok) {
        throw parseProblem(payload, response.status)
      }

      const parsed = bootstrapSchema.safeParse(payload)
      if (!parsed.success) {
        throw new ApiClientError(invalidResponseProblem(), response.status)
      }
      csrfToken = parsed.data.csrfToken
      return parsed.data
    }).catch((error: unknown) => {
      bootstrapPromise = undefined
      csrfToken = undefined
      throw error
    })

    return bootstrapPromise
  }

  const request = async <T>(
    path: string,
    options: ApiRequestOptions,
  ): Promise<T> => {
    assertApiPath(path)
    await bootstrap(options.signal)

    const headers = new Headers(options.headers)
    const method = (options.method ?? 'GET').toUpperCase()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('x-csrf-token', csrfToken ?? '')
    }
    const { body: requestBody, signal, ...requestOptions } = options
    const body = prepareBody(requestBody, headers)
    const response = await fetchImpl(path, {
      ...requestOptions,
      ...(body === undefined ? {} : { body }),
      credentials: 'same-origin',
      headers,
      method,
      signal,
    })
    const payload = await parseJson(response)
    if (!response.ok) {
      throw parseProblem(payload, response.status)
    }

    const success = apiSuccessSchema.safeParse(payload)
    return (success.success ? success.data.data : payload) as T
  }

  return { bootstrap, request }
}

export const apiClient = createApiClient()
