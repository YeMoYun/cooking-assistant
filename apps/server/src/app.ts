import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { AppError } from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import Fastify, {
  type FastifyInstance,
  LogController,
} from 'fastify';
import { registerRecipeNoteRoutes } from './features/recipes/note-routes.js';
import { registerPendingActionRoutes } from './features/actions/pending-action-routes.js';
import { registerPrivacyRoutes } from './features/privacy/privacy-routes.js';
import { registerRecipeRoutes } from './features/recipes/recipe-routes.js';
import { registerRecipeCoverRoutes } from './features/recipes/recipe-cover-routes.js';
import { registerRecipeSearchRoutes } from './features/recipes/search-routes.js';
import { registerInventoryRoutes } from './features/inventory/inventory-routes.js';
import { registerShoppingRoutes } from './features/shopping/shopping-routes.js';
import { registerProviderRoutes } from './features/providers/provider-routes.js';
import { JsonModelClient } from './features/providers/json-model-client.js';
import { ProviderRepository } from './features/providers/provider-repository.js';
import type { SecretStore } from './features/providers/secret-store.js';
import { GuardedVariantAdapter } from './features/variants/variant-adapter.js';
import { registerVariantRoutes } from './features/variants/variant-routes.js';
import { registerVoiceRoutes } from './features/voice/stream-route.js';
import {
  DatabaseVisionProviderSource,
  QwenVlAdapter,
} from './features/vision/qwen-vl-adapter.js';
import { VisionImagePipeline } from './features/vision/image-pipeline.js';
import { registerVisionRoutes } from './features/vision/vision-routes.js';
import { VisionService } from './features/vision/vision-service.js';
import { errorHandler } from './plugins/error-handler.js';
import {
  DEFAULT_REQUEST_BODY_LIMIT,
  installRequestSecurity,
  ROUTE_SECURITY_CONFIGS,
  type MaintenanceRequestOptions,
  type RateLimitPolicyName,
  type RouteRateLimitPolicy,
} from './plugins/request-security.js';
import {
  DEFAULT_SESSION_TTL_MS,
  MemorySessionStore,
  SESSION_COOKIE_NAME,
  type Clock,
  type RandomBytes,
} from './plugins/session.js';

export const PRODUCTION_ALLOWED_HOSTS = [
  'localhost:4173',
  '127.0.0.1:4173',
] as const;

export type BootstrapResponse = {
  csrfToken: string;
  sessionExpiresAt: string;
  capabilities: {
    speechRecognition: 'browser-detect';
    speechSynthesis: 'browser-detect';
  };
};

export interface LoggerStream {
  write(message: string): void;
}

export interface BuildAppOptions {
  readonly allowLoopbackProviderHttp?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly allowedMutationOrigins?: readonly string[];
  readonly database?: Database.Database;
  readonly loggerEnabled?: boolean;
  readonly loggerStream?: LoggerStream;
  readonly maintenance?: MaintenanceRequestOptions;
  readonly now?: Clock;
  readonly randomBytes?: RandomBytes;
  readonly rateLimits?: Partial<
    Readonly<Record<RateLimitPolicyName, RouteRateLimitPolicy>>
  >;
  readonly recipeCoverCacheDirectory?: string;
  readonly recipeMediaOrigins?: readonly string[];
  readonly secureCookies?: boolean;
  readonly secretStore?: SecretStore;
  readonly sessionTtlMs?: number;
  readonly visionTempDirectory?: string;
  readonly webDistDirectory?: string;
}

const HTTPS_ORIGIN_PATTERN = /^https:\/\/[^/?#]+\/?$/u;

export const normalizeRecipeMediaOrigins = (
  origins: readonly string[],
): readonly string[] => {
  const normalizedOrigins = new Set<string>();

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError('Invalid recipe media origin');
    }

    if (
      !HTTPS_ORIGIN_PATTERN.test(origin)
      || parsed.protocol !== 'https:'
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.hostname.length === 0
      || parsed.hostname.includes('*')
      || parsed.pathname !== '/'
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new TypeError('Invalid recipe media origin');
    }

    normalizedOrigins.add(parsed.origin);
  }

  return [...normalizedOrigins];
};

const SAFE_LOG_ERROR_CODES = new Set([
  'forbidden',
  'payload_too_large',
  'rate_limited',
  'validation_error',
]);

const getErrorCode = (error: unknown): string | undefined => {
  if (
    typeof error !== 'object'
    || error === null
    || !('code' in error)
    || typeof error.code !== 'string'
  ) {
    return undefined;
  }
  return error.code;
};

const getSafeLogErrorCode = (error: unknown): string => {
  const errorCode = getErrorCode(error);
  if (errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return 'payload_too_large';
  }
  if (errorCode === 'FST_ERR_VALIDATION') {
    return 'validation_error';
  }
  if (error instanceof AppError && SAFE_LOG_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  return 'internal_error';
};

const installStructuredLogging = (app: FastifyInstance): void => {
  const errorCodes = new WeakMap<object, string>();
  const startTimes = new WeakMap<object, bigint>();

  app.addHook('onRequest', (request, _reply, done) => {
    startTimes.set(request, process.hrtime.bigint());
    done();
  });
  app.addHook('onError', (request, _reply, error, done) => {
    errorCodes.set(request, getSafeLogErrorCode(error));
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const startedAt = startTimes.get(request) ?? process.hrtime.bigint();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const errorCode = errorCodes.get(request);

    request.log.info({
      durationMs,
      ...(errorCode === undefined ? {} : { errorCode }),
      method: request.method,
      requestId: request.id,
      routePattern: request.routeOptions.url,
      status: reply.statusCode,
    }, 'request completed');
    done();
  });
};

export const buildApp = (options: BuildAppOptions = {}): FastifyInstance => {
  const recipeMediaOrigins = normalizeRecipeMediaOrigins(
    options.recipeMediaOrigins ?? [],
  );
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new MemorySessionStore({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomBytes === undefined
      ? {}
      : { randomBytes: options.randomBytes }),
    ttlMs: sessionTtlMs,
  });
  const app = Fastify({
    bodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.loggerEnabled === false
      ? false
      : {
          level: 'info',
          redact: {
            paths: [
              'authorization',
              'apiKey',
              'cookie',
              'credential',
              'csrfToken',
              'imageBytes',
              'maintenanceToken',
              'password',
              'prompt',
              'rawModelError',
              'req.body.apiKey',
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["api-key"]',
              'req.headers["x-maintenance-token"]',
              'req.headers["x-csrf-token"]',
              'secret',
              'transcript',
              '["api-key"]',
              '["x-csrf-token"]',
              '["x-maintenance-token"]',
            ],
            remove: true,
          },
          ...(options.loggerStream === undefined
            ? {}
            : { stream: options.loggerStream }),
        },
  });

  void app.register(fastifyCookie);
  void app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        defaultSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        frameSrc: ["'self'", ...recipeMediaOrigins],
        imgSrc: ["'self'", ...recipeMediaOrigins],
        mediaSrc: ["'self'", ...recipeMediaOrigins],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
      useDefaults: false,
    },
    hsts: false,
  });
  void app.register(fastifyRateLimit, {
    errorResponseBuilder: () => new AppError(
      'rate_limited',
      'Too many requests',
      429,
    ),
    global: false,
  });
  installStructuredLogging(app);
  app.setErrorHandler((error, request, reply) => {
    if (getErrorCode(error) === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      errorHandler(new AppError(
        'payload_too_large',
        'Request body is too large',
        413,
      ), request, reply);
      return;
    }

    errorHandler(error, request, reply);
  });
  installRequestSecurity(app, {
    allowedHosts: options.allowedHosts ?? PRODUCTION_ALLOWED_HOSTS,
    ...(options.allowedMutationOrigins === undefined
      ? {}
      : { allowedMutationOrigins: options.allowedMutationOrigins }),
    ...(options.maintenance === undefined
      ? {}
      : { maintenance: options.maintenance }),
    ...(options.rateLimits === undefined
      ? {}
      : { rateLimits: options.rateLimits }),
    sessions,
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    if (
      (request.url === '/api' || request.url.startsWith('/api/'))
      && !request.url.startsWith('/api/recipe-covers/')
    ) {
      reply.header('Cache-Control', 'no-store');
    }
    done(null, payload);
  });

  if (options.webDistDirectory !== undefined) {
    const webDistDirectory = options.webDistDirectory;
    void app.register(fastifyStatic, {
      cacheControl: false,
      root: webDistDirectory,
      setHeaders: (reply, filePath) => {
        const normalizedPath = filePath.replaceAll('\\', '/');
        if (normalizedPath.endsWith('/index.html')) {
          reply.header('Cache-Control', 'no-cache');
        } else if (normalizedPath.includes('/assets/')) {
          reply.header(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
        }
      },
      wildcard: false,
    });
  }

  app.after(() => {
    if (options.database !== undefined) {
      if (options.recipeCoverCacheDirectory !== undefined) {
        registerRecipeCoverRoutes(
          app,
          options.database,
          options.recipeCoverCacheDirectory,
        );
      }
      registerRecipeSearchRoutes(app, options.database);
      registerRecipeRoutes(app, options.database);
      registerRecipeNoteRoutes(app, options.database);
      registerPendingActionRoutes(app, options.database);
      registerInventoryRoutes(app, options.database);
      registerShoppingRoutes(app, options.database);
      if (options.secretStore !== undefined) {
        const modelClient = new JsonModelClient(options.secretStore);
        registerProviderRoutes(app, options.database, options.secretStore, {
          allowLoopbackHttp: options.allowLoopbackProviderHttp ?? false,
        });
        registerVariantRoutes(
          app,
          options.database,
          new GuardedVariantAdapter(
            new ProviderRepository(options.database),
            modelClient,
          ),
        );
        registerVoiceRoutes(app, options.database, options.secretStore);
        registerPrivacyRoutes(app, {
          database: options.database,
          secretStore: options.secretStore,
          sessions,
          temporaryDirectories: options.visionTempDirectory === undefined
            ? [] : [options.visionTempDirectory],
        });
        if (options.visionTempDirectory !== undefined) {
          const visionAdapter = new QwenVlAdapter(
            new DatabaseVisionProviderSource(options.database),
            modelClient,
          );
          registerVisionRoutes(app, {
            imagePipeline: new VisionImagePipeline({
              tempDirectory: options.visionTempDirectory,
            }),
            service: new VisionService(options.database, visionAdapter),
          });
        }
      }
    }
    app.get('/api/health', () => ({ data: { status: 'ok' } }));
    app.get('/api/bootstrap', {
      config: ROUTE_SECURITY_CONFIGS.bootstrap,
    }, (_request, reply) => {
      const session = sessions.create();
      reply.setCookie(SESSION_COOKIE_NAME, session.sessionId, {
        httpOnly: true,
        maxAge: Math.floor(sessionTtlMs / 1_000),
        path: '/',
        sameSite: 'strict',
        secure: options.secureCookies ?? false,
      });

      const response: BootstrapResponse = {
        csrfToken: session.csrfToken,
        sessionExpiresAt: new Date(session.expiresAt).toISOString(),
        capabilities: {
          speechRecognition: 'browser-detect',
          speechSynthesis: 'browser-detect',
        },
      };
      return response;
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url === '/api' || request.url.startsWith('/api/')) {
        errorHandler(
          new AppError('not_found', '接口不存在', 404),
          request,
          reply,
        );
        return;
      }

      const acceptsHtml = request.method === 'GET'
        && request.headers.accept?.split(',').some((value) => (
          value.trim().toLowerCase().startsWith('text/html')
        )) === true;
      if (options.webDistDirectory !== undefined && acceptsHtml) {
        reply
          .header('Cache-Control', 'no-cache')
          .type('text/html')
          .sendFile('index.html', { cacheControl: false });
        return;
      }

      errorHandler(
        new AppError('not_found', '资源不存在', 404),
        request,
        reply,
      );
    });
  });

  return app;
};
