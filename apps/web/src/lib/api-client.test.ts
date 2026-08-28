// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { ApiClientError, createApiClient } from './api-client'

type FetchCall = {
  readonly input: RequestInfo | URL
  readonly init: RequestInit | undefined
}

const jsonResponse = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  {
    headers: { 'content-type': 'application/json' },
    status,
  },
)

const bootstrapResponse = {
  capabilities: {
    speechRecognition: 'browser-detect',
    speechSynthesis: 'browser-detect',
  },
  csrfToken: 'csrf-token-from-bootstrap',
  sessionExpiresAt: '2026-08-24T12:30:00.000Z',
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('createApiClient', () => {
  it('bootstraps once, keeps CSRF out of storage, and sends it on a POST', async () => {
    const calls: FetchCall[] = []
    const fetchStub: typeof fetch = (input, init) => {
      calls.push({ input, init })
      if (input === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(bootstrapResponse))
      }
      return Promise.resolve(jsonResponse({ data: { saved: true } }))
    }
    const client = createApiClient({ fetch: fetchStub })
    const signal = new AbortController().signal

    await client.bootstrap(signal)
    await client.bootstrap(signal)
    const result = await client.request<{ saved: boolean }>(
      '/api/shopping/items',
      {
        body: { ingredient: '番茄' },
        method: 'POST',
        signal,
      },
    )

    expect(result).toEqual({ saved: true })
    expect(calls.map(({ input }) => input)).toEqual([
      '/api/bootstrap',
      '/api/shopping/items',
    ])
    expect(calls.every(({ init }) => init?.credentials === 'same-origin'))
      .toBe(true)
    expect(calls.every(({ init }) => init?.signal === signal)).toBe(true)
    const postHeaders = new Headers(calls[1]?.init?.headers)
    expect(postHeaders.get('x-csrf-token')).toBe('csrf-token-from-bootstrap')
    expect(postHeaders.get('content-type')).toBe('application/json')
    expect(localStorage).toHaveLength(0)
    expect(sessionStorage).toHaveLength(0)
  })

  it('parses the shared problem envelope into an ApiClientError', async () => {
    const fetchStub: typeof fetch = (input) => {
      if (input === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(bootstrapResponse))
      }
      return Promise.resolve(jsonResponse({
        error: {
          code: 'validation_error',
          details: { field: 'name' },
          message: '菜名不能为空',
          requestId: 'request-123',
        },
      }, 422))
    }
    const client = createApiClient({ fetch: fetchStub })

    const request = client.request('/api/recipes', {
      method: 'POST',
      signal: new AbortController().signal,
    })

    await expect(request).rejects.toMatchObject({
      code: 'validation_error',
      details: { field: 'name' },
      message: '菜名不能为空',
      name: 'ApiClientError',
      requestId: 'request-123',
      statusCode: 422,
    })
  })

  it('never retries a failed model request', async () => {
    let calls = 0
    const fetchStub: typeof fetch = (input) => {
      calls += 1
      if (input === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(bootstrapResponse))
      }
      return Promise.resolve(jsonResponse({
        error: {
          code: 'provider_unavailable',
          message: '模型暂时不可用',
          requestId: 'request-model-1',
        },
      }, 503))
    }
    const client = createApiClient({ fetch: fetchStub })

    await expect(client.request('/api/assistant/chat', {
      body: { message: '下一步怎么做？' },
      method: 'POST',
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ApiClientError)
    expect(calls).toBe(2)
  })

  it('rejects URLs outside the relative API boundary before fetching', async () => {
    let calls = 0
    const fetchStub: typeof fetch = () => {
      calls += 1
      return Promise.resolve(jsonResponse(bootstrapResponse))
    }
    const client = createApiClient({ fetch: fetchStub })

    await expect(client.request('https://example.com/api/recipes', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toThrow('API path must be a relative /api URL')
    await expect(client.request('/api/../outside', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toThrow('API path must be a relative /api URL')
    expect(calls).toBe(0)
  })
})
