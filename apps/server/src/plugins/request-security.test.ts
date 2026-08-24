import { apiProblemSchema } from '@xiaochu/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildApp,
  type BootstrapResponse,
  type BuildAppOptions,
} from '../app.js';
import {
  DEFAULT_REQUEST_BODY_LIMIT,
  maintenanceRouteSecurityConfig,
  MAINTENANCE_TOKEN_HEADER,
  OneTimeMaintenanceTokenStore,
  ROUTE_SECURITY_CONFIGS,
  VISION_UPLOAD_BODY_LIMIT,
} from './request-security.js';

const ALLOWED_HOSTS = ['localhost:4173', '127.0.0.1:4173'] as const;
const apps: FastifyInstance[] = [];

interface BootstrapSession {
  readonly cookie: string;
  readonly response: BootstrapResponse;
}

const buildTestApp = (options: Omit<BuildAppOptions, 'allowedHosts'> = {}) => {
  const app = buildApp({
    ...options,
    allowedHosts: ALLOWED_HOSTS,
    loggerEnabled: options.loggerStream !== undefined,
  });
  app.post('/api/test-write', (request) => ({ data: request.body }));
  apps.push(app);
  return app;
};

const getSingleHeader = (
  value: string | string[] | undefined,
): string => {
  expect(value).toBeTypeOf('string');
  return value as string;
};

const bootstrap = async (
  app: FastifyInstance,
  host = ALLOWED_HOSTS[0],
): Promise<BootstrapSession> => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/bootstrap',
    headers: { host },
  });
  expect(response.statusCode).toBe(200);

  const setCookie = getSingleHeader(response.headers['set-cookie']);
  return {
    cookie: setCookie.split(';', 1)[0] as string,
    response: response.json<BootstrapResponse>(),
  };
};

const mutationHeaders = (
  session: BootstrapSession,
): Record<string, string> => ({
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
  cookie: session.cookie,
  'x-csrf-token': session.response.csrfToken,
});

const expectForbiddenProblem = (response: {
  readonly json: () => unknown;
  readonly statusCode: number;
}): void => {
  expect(response.statusCode).toBe(403);
  const problem = apiProblemSchema.parse(response.json());
  expect(problem.error.code).toBe('forbidden');
  expect(problem.error.requestId).toBeTruthy();
};

const parseCsp = (header: string): Map<string, string[]> => new Map(
  header
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0)
    .map((directive) => {
      const [name, ...values] = directive.split(/\s+/u);
      return [name as string, values];
    }),
);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('loopback host and origin boundary', () => {
  it('serves health through an allowed loopback host', async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:4173' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'ok' } });
  });

  it.each(['evil.example', 'localhost:41730', 'sub.localhost:4173'])(
    'rejects disallowed Host %s even for GET',
    async (host) => {
      const app = buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host },
      });

      expectForbiddenProblem(response);
    },
  );

  it.each([
    ['evil.example', 'http://localhost:4173'],
    ['localhost:4173', 'https://evil.example'],
  ])('rejects host/origin pair %s %s', async (host, origin) => {
    const app = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: { host, origin },
      payload: { value: 1 },
    });

    expectForbiddenProblem(response);
  });

  it.each([
    ['localhost:4173', 'http://127.0.0.1:4173'],
    ['127.0.0.1:4173', 'http://localhost:4173'],
  ])('rejects cross-paired loopback authorities %s %s', async (host, origin) => {
    const app = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: { host, origin },
      payload: { value: 1 },
    });

    expectForbiddenProblem(response);
  });

  it('rejects a same-origin mutation without CSRF state', async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: {
        host: 'localhost:4173',
        origin: 'http://localhost:4173',
      },
      payload: { value: 1 },
    });

    expectForbiddenProblem(response);
  });
});

describe('bootstrap session and CSRF policy', () => {
  it('issues independent 256-bit session and CSRF values with strict cookie attributes', async () => {
    const app = buildTestApp();

    const firstResponse = await app.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { host: 'localhost:4173' },
    });
    const second = await bootstrap(app);

    expect(firstResponse.statusCode).toBe(200);
    const firstBody = firstResponse.json<BootstrapResponse>();
    const firstSetCookie = getSingleHeader(firstResponse.headers['set-cookie']);
    const firstCookiePair = firstSetCookie.split(';', 1)[0] as string;
    const firstSessionId = firstCookiePair.slice(firstCookiePair.indexOf('=') + 1);
    const secondSessionId = second.cookie.slice(second.cookie.indexOf('=') + 1);

    expect(Buffer.from(firstSessionId, 'base64url')).toHaveLength(32);
    expect(Buffer.from(firstBody.csrfToken, 'base64url')).toHaveLength(32);
    expect(firstSessionId).not.toBe(secondSessionId);
    expect(firstBody.csrfToken).not.toBe(second.response.csrfToken);
    expect(firstSetCookie).toContain('HttpOnly');
    expect(firstSetCookie).toContain('SameSite=Strict');
    expect(firstSetCookie).toContain('Path=/');
    expect(firstSetCookie).not.toContain('Secure');
    expect(firstBody.capabilities).toEqual({
      speechRecognition: 'browser-detect',
      speechSynthesis: 'browser-detect',
    });
    expect(Number.isNaN(Date.parse(firstBody.sessionExpiresAt))).toBe(false);
  });

  it('accepts a bootstrap cookie with its exact CSRF token', async () => {
    const app = buildTestApp();
    const session = await bootstrap(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: {
        host: 'localhost:4173',
        origin: 'http://localhost:4173',
        cookie: session.cookie,
        'x-csrf-token': session.response.csrfToken,
      },
      payload: { value: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { value: 1 } });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['wrong CSRF token', 'another session CSRF token', 'unknown session cookie'])(
    'returns the same 403 for %s',
    async (scenario) => {
      const app = buildTestApp();
      const first = await bootstrap(app);
      const second = await bootstrap(app);
      const cookie = scenario === 'unknown session cookie'
        ? `${first.cookie.split('=', 1)[0]}=${'u'.repeat(43)}`
        : first.cookie;
      const csrfToken = scenario === 'another session CSRF token'
        ? second.response.csrfToken
        : scenario === 'wrong CSRF token'
          ? 'not-the-token'
          : first.response.csrfToken;

      const response = await app.inject({
        method: 'POST',
        url: '/api/test-write',
        headers: {
          host: 'localhost:4173',
          origin: 'http://localhost:4173',
          cookie,
          'x-csrf-token': csrfToken,
        },
        payload: { value: 1 },
      });

      expectForbiddenProblem(response);
    },
  );

  it('rejects an expired session without sleeping', async () => {
    let now = Date.parse('2026-08-24T08:00:00.000Z');
    const app = buildTestApp({
      now: () => now,
      sessionTtlMs: 1_000,
    });
    const session = await bootstrap(app);
    now += 1_000;

    const response = await app.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: {
        host: 'localhost:4173',
        origin: 'http://localhost:4173',
        cookie: session.cookie,
        'x-csrf-token': session.response.csrfToken,
      },
      payload: { value: 1 },
    });

    expectForbiddenProblem(response);
  });
});

describe('request body limits', () => {
  it('allows 10 MiB only on the exact vision upload route', async () => {
    const app = buildTestApp();
    app.post('/api/vision/recognize', (request) => ({
      data: { bodyLimit: request.routeOptions.bodyLimit },
    }));
    app.post('/api/vision/recognize-similar', {
      bodyLimit: VISION_UPLOAD_BODY_LIMIT,
    }, () => ({ data: null }));
    const session = await bootstrap(app);
    const payload = JSON.stringify({
      image: 'x'.repeat(DEFAULT_REQUEST_BODY_LIMIT + 1),
    });

    const exactResponse = await app.inject({
      method: 'POST',
      url: '/api/vision/recognize',
      headers: {
        ...mutationHeaders(session),
        'content-type': 'application/json',
      },
      payload,
    });
    const similarResponse = await app.inject({
      method: 'POST',
      url: '/api/vision/recognize-similar',
      headers: {
        ...mutationHeaders(session),
        'content-type': 'application/json',
      },
      payload,
    });

    expect(exactResponse.statusCode).toBe(200);
    expect(exactResponse.json()).toEqual({
      data: { bodyLimit: VISION_UPLOAD_BODY_LIMIT },
    });
    expect(similarResponse.statusCode).toBe(413);
    const problem = apiProblemSchema.parse(similarResponse.json());
    expect(problem.error.code).toBe('payload_too_large');
    expect(problem.error.requestId).toBeTruthy();
  });
});

describe('route-specific rate limits', () => {
  it('rate limits bootstrap and provider tests without limiting health', async () => {
    const app = buildTestApp({
      rateLimits: {
        bootstrap: { max: 1, timeWindow: 60_000 },
        providerTest: { max: 1, timeWindow: 60_000 },
      },
    });
    app.after(() => {
      app.post('/api/test-provider', {
        config: ROUTE_SECURITY_CONFIGS.providerTest,
      }, () => ({ data: { connected: true } }));
    });

    const firstBootstrap = await app.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { host: 'localhost:4173' },
    });
    const secondBootstrap = await app.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { host: 'localhost:4173' },
    });
    const firstCookie = getSingleHeader(firstBootstrap.headers['set-cookie'])
      .split(';', 1)[0] as string;
    const firstSession: BootstrapSession = {
      cookie: firstCookie,
      response: firstBootstrap.json<BootstrapResponse>(),
    };

    const firstProvider = await app.inject({
      method: 'POST',
      url: '/api/test-provider',
      headers: mutationHeaders(firstSession),
      payload: { provider: 'test' },
    });
    const secondProvider = await app.inject({
      method: 'POST',
      url: '/api/test-provider',
      headers: mutationHeaders(firstSession),
      payload: { provider: 'test' },
    });
    const healthResponses = await Promise.all(Array.from(
      { length: 3 },
      () => app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'localhost:4173' },
      }),
    ));

    expect(firstBootstrap.statusCode).toBe(200);
    expect(secondBootstrap.statusCode).toBe(429);
    expect(apiProblemSchema.parse(secondBootstrap.json()).error.code)
      .toBe('rate_limited');
    expect(firstProvider.statusCode).toBe(200);
    expect(secondProvider.statusCode).toBe(429);
    expect(apiProblemSchema.parse(secondProvider.json()).error.code)
      .toBe('rate_limited');
    expect(healthResponses.map((response) => response.statusCode))
      .toEqual([200, 200, 200]);
  });
});

describe('content security policy', () => {
  it('keeps executable and network sources self-only and normalizes media origins', async () => {
    const app = buildTestApp({
      recipeMediaOrigins: [
        'https://MEDIA.example:443/',
        'https://media.example',
        'https://cdn.example:8443',
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:4173' },
    });
    const cspHeader = getSingleHeader(
      response.headers['content-security-policy'],
    );
    const csp = parseCsp(cspHeader);

    expect(response.statusCode).toBe(200);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(["'self'"]);
    expect(csp.get('img-src')).toEqual([
      "'self'",
      'https://media.example',
      'https://cdn.example:8443',
    ]);
    expect(csp.get('media-src')).toEqual(csp.get('img-src'));
    expect(csp.get('frame-src')).toEqual(csp.get('img-src'));
    expect(cspHeader).not.toMatch(/unsafe-inline|unsafe-eval|\*/u);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    'http://media.example',
    'https://user:password@media.example',
    'https://media.example/path',
    'https://media.example?token=secret',
    'https://*.example',
    'https://media.example; script-src *',
  ])('fails closed for invalid recipe media origin %s', (origin) => {
    expect(() => buildTestApp({
      recipeMediaOrigins: ['https://safe.example', origin],
    })).toThrow('Invalid recipe media origin');
  });
});

describe('structured request logging', () => {
  it('logs only request metadata and a safe error code', async () => {
    const canaries = {
      body: 'BODY-CANARY-4d649f',
      cookie: 'COOKIE-CANARY-e1827d',
      error: 'ERROR-CANARY-877e82',
      header: 'HEADER-CANARY-806bb0',
      image: 'IMAGE-CANARY-bf1150',
      query: 'QUERY-CANARY-2357cc',
      secret: 'SECRET-CANARY-a3362b',
      transcript: 'TRANSCRIPT-CANARY-18ac61',
    } as const;
    const logLines: string[] = [];
    const app = buildTestApp({
      loggerStream: {
        write: (line) => {
          logLines.push(line);
        },
      },
    });
    app.post('/api/test-log-error', () => {
      throw Object.assign(
        new Error(`raw model error ${canaries.error}`),
        { rawModelError: canaries.error },
      );
    });
    const session = await bootstrap(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/test-log-error?query=${canaries.query}&prompt=hidden`,
      headers: {
        ...mutationHeaders(session),
        authorization: `Bearer ${canaries.header}`,
        'api-key': canaries.secret,
        cookie: `${session.cookie}; private=${canaries.cookie}`,
      },
      payload: {
        imageBytes: canaries.image,
        prompt: canaries.body,
        secret: canaries.secret,
        transcript: canaries.transcript,
      },
    });
    const problem = apiProblemSchema.parse(response.json());
    const logs = logLines.join('');
    const normalizedLogs = logs.toLowerCase();

    expect(response.statusCode).toBe(500);
    expect(logs).toContain(problem.error.requestId);
    expect(logs).toContain('/api/test-log-error');
    expect(logs).toContain('"method":"POST"');
    expect(logs).toContain('"status":500');
    expect(logs).toContain('"durationMs":');
    expect(logs).toContain('"errorCode":"internal_error"');
    expect(logs).not.toContain('?query=');
    for (const canary of Object.values(canaries)) {
      expect(logs).not.toContain(canary);
    }
    for (const sensitiveName of [
      'authorization',
      'api-key',
      'cookie',
      'csrf',
      'imagebytes',
      'prompt',
      'rawmodelerror',
      'transcript',
    ]) {
      expect(normalizedLogs).not.toContain(sensitiveName);
    }
  });
});

describe('one-time CLI maintenance exception', () => {
  it('consumes a token only on its explicitly registered route name', async () => {
    const tokenStore = new OneTimeMaintenanceTokenStore();
    const token = tokenStore.issue();
    const app = buildTestApp({
      maintenance: {
        routeNames: ['test-maintenance'],
        tokenStore,
      },
    });
    app.post('/api/test-maintenance', {
      config: maintenanceRouteSecurityConfig('test-maintenance'),
    }, () => ({ data: { maintained: true } }));

    const wrongResponse = await app.inject({
      method: 'POST',
      url: '/api/test-maintenance',
      headers: {
        host: 'localhost:4173',
        [MAINTENANCE_TOKEN_HEADER]: 'wrong-token',
      },
      payload: { action: 'test' },
    });
    const nonMaintenanceResponse = await app.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: {
        host: 'localhost:4173',
        [MAINTENANCE_TOKEN_HEADER]: token,
      },
      payload: { action: 'test' },
    });
    const successResponse = await app.inject({
      method: 'POST',
      url: '/api/test-maintenance',
      headers: {
        host: 'localhost:4173',
        [MAINTENANCE_TOKEN_HEADER]: token,
      },
      payload: { action: 'test' },
    });
    const replayResponse = await app.inject({
      method: 'POST',
      url: '/api/test-maintenance',
      headers: {
        host: 'localhost:4173',
        [MAINTENANCE_TOKEN_HEADER]: token,
      },
      payload: { action: 'test' },
    });

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expectForbiddenProblem(wrongResponse);
    expectForbiddenProblem(nonMaintenanceResponse);
    expect(successResponse.statusCode).toBe(200);
    expect(successResponse.json()).toEqual({ data: { maintained: true } });
    expectForbiddenProblem(replayResponse);
  });
});
