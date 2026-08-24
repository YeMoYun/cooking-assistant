import { AppError, apiProblemSchema } from '@xiaochu/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { errorHandler } from './error-handler.js';

const CANARY = 'super-secret-canary-9320';
const REQUEST_ID_HEADER = 'x-test-request-id';
const apps: FastifyInstance[] = [];

const buildTestApp = (): FastifyInstance => {
  const app = Fastify({
    logger: false,
    genReqId: (request) => {
      const requestId = request.headers[REQUEST_ID_HEADER];
      return typeof requestId === 'string' ? requestId : 'fallback-request-id';
    },
  });

  app.setErrorHandler(errorHandler);
  apps.push(app);
  return app;
};

const sensitiveHeaders = {
  authorization: 'Authorization: Bearer secret-token',
  'api-key': 'api-key-secret',
};

const expectNoSensitiveData = (body: string): void => {
  expect(body).not.toContain('Authorization');
  expect(body).not.toContain('api-key');
  expect(body).not.toContain(CANARY);
};

const circularDetails: Record<string, unknown> = { marker: CANARY };
circularDetails.self = circularDetails;

const deeplyNestedDetails = {
  level1: {
    level2: {
      level3: {
        level4: {
          level5: {
            level6: {
              marker: CANARY,
            },
          },
        },
      },
    },
  },
};

const tooManyDetails: Record<string, unknown> = { marker: CANARY };
for (let index = 0; index < 101; index += 1) {
  tooManyDetails[`field${String(index)}`] = index;
}

const sensitiveDetailKeys = [
  'authorization',
  'api-key',
  'apiKey',
  'token',
  'secret',
  'password',
  'credential',
  'cookie',
  'stack',
  'response',
  'body',
] as const;

const unsafeDetailsCases: ReadonlyArray<readonly [string, unknown]> = [
  ...sensitiveDetailKeys.map((key) => [
    `nested sensitive key ${key}`,
    { public: { [key]: CANARY } },
  ] as const),
  ['circular reference', circularDetails],
  ['BigInt', { marker: CANARY, value: 1n }],
  ['non-finite number', { marker: CANARY, value: Number.NaN }],
  ['non-plain object', { marker: CANARY, value: new Date(0) }],
  ['depth limit', deeplyNestedDetails],
  ['entry limit', tooManyDetails],
  ['serialized size limit', { marker: CANARY, value: 'x'.repeat(5_000) }],
];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('errorHandler', () => {
  it('maps Fastify route validation errors to validation_error', async () => {
    const app = buildTestApp();
    app.post('/validation', {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string' } },
        },
      },
    }, () => ({ data: null }));

    const response = await app.inject({
      method: 'POST',
      url: '/validation',
      headers: {
        ...sensitiveHeaders,
        [REQUEST_ID_HEADER]: 'validation-request-id',
      },
      payload: {},
    });
    const body = apiProblemSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.requestId).toBe('validation-request-id');
    expectNoSensitiveData(response.body);
  });

  it('redacts a ZodError thrown inside a route handler', async () => {
    const app = buildTestApp();
    app.get('/internal-zod-error', () => {
      throw new ZodError([{
        code: 'custom',
        path: ['upstream'],
        message: `upstream validation failed ${CANARY}`,
      }]);
    });

    const response = await app.inject({
      method: 'GET',
      url: '/internal-zod-error',
      headers: {
        ...sensitiveHeaders,
        [REQUEST_ID_HEADER]: 'internal-zod-request-id',
      },
    });
    const body = apiProblemSchema.parse(response.json());

    expect(response.statusCode).toBe(500);
    expect(body).toEqual({
      error: {
        code: 'internal_error',
        message: '服务器内部错误',
        requestId: 'internal-zod-request-id',
      },
    });
    expectNoSensitiveData(response.body);
  });

  it('preserves known AppError fields and safe details', async () => {
    const app = buildTestApp();
    app.get('/known', () => {
      throw new AppError(
        'recipe_not_found',
        '未找到菜谱',
        404,
        { recipeId: 'recipe-123' },
      );
    });

    const response = await app.inject({
      method: 'GET',
      url: '/known',
      headers: {
        ...sensitiveHeaders,
        [REQUEST_ID_HEADER]: 'known-request-id',
      },
    });
    const body = apiProblemSchema.parse(response.json());

    expect(response.statusCode).toBe(404);
    expect(body).toEqual({
      error: {
        code: 'recipe_not_found',
        message: '未找到菜谱',
        requestId: 'known-request-id',
        details: { recipeId: 'recipe-123' },
      },
    });
    expectNoSensitiveData(response.body);
  });

  it.each([200, 600, Number.NaN])(
    'redacts AppError with invalid status %s',
    async (statusCode) => {
      const app = buildTestApp();
      app.get('/invalid-app-error-status', () => {
        throw new AppError(
          'FST_ERR_VALIDATION',
          `invalid status leaked ${CANARY}`,
          statusCode,
          { marker: CANARY },
        );
      });

      const response = await app.inject({
        method: 'GET',
        url: '/invalid-app-error-status',
        headers: {
          ...sensitiveHeaders,
          [REQUEST_ID_HEADER]: 'invalid-status-request-id',
        },
      });
      const body = apiProblemSchema.parse(response.json());

      expect(response.statusCode).toBe(500);
      expect(body).toEqual({
        error: {
          code: 'internal_error',
          message: '服务器内部错误',
          requestId: 'invalid-status-request-id',
        },
      });
      expectNoSensitiveData(response.body);
    },
  );

  it.each(unsafeDetailsCases)(
    'omits unsafe AppError details: %s',
    async (_label, details) => {
      const app = buildTestApp();
      app.get('/unsafe-app-error-details', () => {
        throw new AppError(
          'invalid_recipe',
          '菜谱数据无效',
          422,
          details,
        );
      });

      const response = await app.inject({
        method: 'GET',
        url: '/unsafe-app-error-details',
        headers: {
          ...sensitiveHeaders,
          [REQUEST_ID_HEADER]: 'unsafe-details-request-id',
        },
      });
      const body = apiProblemSchema.parse(response.json());

      expect(response.statusCode).toBe(422);
      expect(body).toEqual({
        error: {
          code: 'invalid_recipe',
          message: '菜谱数据无效',
          requestId: 'unsafe-details-request-id',
        },
      });
      expectNoSensitiveData(response.body);
    },
  );

  it('redacts unknown exceptions and upstream data', async () => {
    const app = buildTestApp();
    const unknownError = Object.assign(
      new Error(`upstream failed: Authorization api-key ${CANARY}`),
      {
        details: {
          authorization: 'Authorization: Bearer secret-token',
          apiKey: 'api-key-secret',
          marker: CANARY,
        },
        response: {
          body: `upstream body: Authorization api-key ${CANARY}`,
        },
      },
    );
    unknownError.stack = `Error: Authorization api-key ${CANARY}`;
    app.get('/unknown', () => {
      throw unknownError;
    });

    const response = await app.inject({
      method: 'GET',
      url: '/unknown',
      headers: {
        ...sensitiveHeaders,
        [REQUEST_ID_HEADER]: 'unknown-request-id',
      },
    });
    const body = apiProblemSchema.parse(response.json());

    expect(response.statusCode).toBe(500);
    expect(body).toEqual({
      error: {
        code: 'internal_error',
        message: '服务器内部错误',
        requestId: 'unknown-request-id',
      },
    });
    expectNoSensitiveData(response.body);
  });
});
