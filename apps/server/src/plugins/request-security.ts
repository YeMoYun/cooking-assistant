import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '@xiaochu/shared';
import type { FastifyInstance } from 'fastify';
import {
  SESSION_COOKIE_NAME,
  type MemorySessionStore,
  type RandomBytes,
} from './session.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const DEFAULT_REQUEST_BODY_LIMIT = 1_024 * 1_024;
export const VISION_UPLOAD_BODY_LIMIT = 10 * 1_024 * 1_024;
export const VISION_UPLOAD_PATH = '/api/vision/recognize';
export const MAINTENANCE_TOKEN_HEADER = 'x-maintenance-token';

const LOCAL_TOKEN_BYTES = 32;
const LOCAL_TOKEN_CHARACTERS = 43;
const MAX_LOCAL_TOKEN_ATTEMPTS = 8;

export type RateLimitPolicyName = (
  | 'bootstrap'
  | 'confirmation'
  | 'modelStream'
  | 'providerTest'
  | 'visionUpload'
);

export interface RouteRateLimitPolicy {
  readonly max: number;
  readonly timeWindow: number;
}

interface RequestSecurityRouteConfig {
  readonly maintenanceRouteName?: string;
  readonly rateLimitPolicy?: RateLimitPolicyName;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    requestSecurity?: RequestSecurityRouteConfig;
  }
}

export const DEFAULT_RATE_LIMIT_POLICIES: Readonly<
  Record<RateLimitPolicyName, RouteRateLimitPolicy>
> = {
  bootstrap: { max: 20, timeWindow: 60_000 },
  confirmation: { max: 10, timeWindow: 60_000 },
  modelStream: { max: 30, timeWindow: 60_000 },
  providerTest: { max: 6, timeWindow: 60_000 },
  visionUpload: { max: 6, timeWindow: 60_000 },
};

const routeConfig = (
  rateLimitPolicy: RateLimitPolicyName,
): { readonly requestSecurity: RequestSecurityRouteConfig } => ({
  requestSecurity: { rateLimitPolicy },
});

export const ROUTE_SECURITY_CONFIGS = {
  bootstrap: routeConfig('bootstrap'),
  confirmation: routeConfig('confirmation'),
  modelStream: routeConfig('modelStream'),
  providerTest: routeConfig('providerTest'),
  visionUpload: routeConfig('visionUpload'),
} as const;

export const maintenanceRouteSecurityConfig = (
  maintenanceRouteName: string,
): { readonly requestSecurity: RequestSecurityRouteConfig } => {
  if (maintenanceRouteName.length === 0) {
    throw new TypeError('Maintenance route name must not be empty');
  }
  return { requestSecurity: { maintenanceRouteName } };
};

export const SENSITIVE_ROUTE_PATTERNS = {
  bootstrap: { method: 'GET', url: '/api/bootstrap' },
  confirmation: {
    method: 'POST',
    url: '/api/confirmations/:confirmationId/confirm',
  },
  modelStream: { method: 'POST', url: '/api/model/stream' },
  providerTest: {
    method: 'POST',
    url: '/api/providers/:providerId/test',
  },
  visionUpload: { method: 'POST', url: VISION_UPLOAD_PATH },
} as const;

export interface OneTimeMaintenanceTokenStoreOptions {
  readonly randomBytes?: RandomBytes;
}

const hashLocalToken = (token: string): Buffer => (
  createHash('sha256').update(token, 'utf8').digest()
);

const isLocalToken = (token: string): boolean => (
  token.length === LOCAL_TOKEN_CHARACTERS
  && Buffer.byteLength(token, 'utf8') === LOCAL_TOKEN_CHARACTERS
  && /^[A-Za-z0-9_-]+$/u.test(token)
);

export class OneTimeMaintenanceTokenStore {
  readonly #randomBytes: RandomBytes;
  readonly #tokenHashes: Buffer[] = [];

  constructor(options: OneTimeMaintenanceTokenStoreOptions = {}) {
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  issue(): string {
    for (let attempt = 0; attempt < MAX_LOCAL_TOKEN_ATTEMPTS; attempt += 1) {
      const bytes = this.#randomBytes(LOCAL_TOKEN_BYTES);
      if (bytes.length !== LOCAL_TOKEN_BYTES) {
        throw new TypeError('Random byte source returned an invalid length');
      }

      const token = bytes.toString('base64url');
      const tokenHash = hashLocalToken(token);
      const alreadyIssued = this.#tokenHashes.some((issuedHash) => (
        timingSafeEqual(tokenHash, issuedHash)
      ));
      if (!alreadyIssued) {
        this.#tokenHashes.push(tokenHash);
        return token;
      }
    }

    throw new Error('Unable to allocate a unique maintenance token');
  }

  consume(token: string): boolean {
    if (!isLocalToken(token)) {
      return false;
    }

    const candidateHash = hashLocalToken(token);
    let matchingIndex = -1;
    for (let index = 0; index < this.#tokenHashes.length; index += 1) {
      const issuedHash = this.#tokenHashes[index];
      if (
        issuedHash !== undefined
        && issuedHash.length === candidateHash.length
        && timingSafeEqual(candidateHash, issuedHash)
        && matchingIndex === -1
      ) {
        matchingIndex = index;
      }
    }

    if (matchingIndex === -1) {
      return false;
    }
    this.#tokenHashes.splice(matchingIndex, 1);
    return true;
  }
}

export interface MaintenanceRequestOptions {
  readonly routeNames: readonly string[];
  readonly tokenStore: OneTimeMaintenanceTokenStore;
}

export interface RequestSecurityOptions {
  readonly allowedHosts: readonly string[];
  readonly maintenance?: MaintenanceRequestOptions;
  readonly rateLimits?: Partial<
    Readonly<Record<RateLimitPolicyName, RouteRateLimitPolicy>>
  >;
  readonly sessions: MemorySessionStore;
}

const forbidden = (): AppError => new AppError(
  'forbidden',
  'Request forbidden',
  403,
);

const getSingleHeader = (
  value: string | string[] | undefined,
): string | undefined => typeof value === 'string' ? value : undefined;

const readSessionCookie = (cookieHeader: string | undefined): string | undefined => {
  if (cookieHeader === undefined) {
    return undefined;
  }

  const prefix = `${SESSION_COOKIE_NAME}=`;
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));

  if (matches.length !== 1) {
    return undefined;
  }

  return matches[0]?.slice(prefix.length);
};

export const installRequestSecurity = (
  app: FastifyInstance,
  options: RequestSecurityOptions,
): void => {
  const allowedHosts = new Set(options.allowedHosts);
  const rateLimits = {
    ...DEFAULT_RATE_LIMIT_POLICIES,
    ...options.rateLimits,
  };

  app.addHook('onRoute', (routeOptions) => {
    routeOptions.bodyLimit = (
      routeOptions.method === 'POST'
      && routeOptions.url === VISION_UPLOAD_PATH
    )
      ? VISION_UPLOAD_BODY_LIMIT
      : DEFAULT_REQUEST_BODY_LIMIT;

    const configuredPolicy = routeOptions.config?.requestSecurity
      ?.rateLimitPolicy;
    const inferredPolicy = Object.entries(SENSITIVE_ROUTE_PATTERNS)
      .find(([, pattern]) => (
        routeOptions.method === pattern.method
        && routeOptions.url === pattern.url
      ))?.[0] as RateLimitPolicyName | undefined;
    const policyName = configuredPolicy ?? inferredPolicy;
    if (policyName !== undefined) {
      const config = routeOptions.config ?? {};
      routeOptions.config = config;
      config.rateLimit = {
        ...rateLimits[policyName],
        groupId: `xiaochu-${policyName}`,
      };
    }
  });

  app.addHook('onRequest', (request) => {
    const host = getSingleHeader(request.headers.host);
    if (host === undefined || !allowedHosts.has(host)) {
      throw forbidden();
    }

    if (!MUTATION_METHODS.has(request.method)) {
      return Promise.resolve();
    }

    const originHeader = request.headers.origin;
    if (originHeader === undefined) {
      const maintenanceRouteName = request.routeOptions.config
        .requestSecurity?.maintenanceRouteName;
      const maintenanceToken = getSingleHeader(
        request.headers[MAINTENANCE_TOKEN_HEADER],
      );
      if (
        options.maintenance !== undefined
        && maintenanceRouteName !== undefined
        && options.maintenance.routeNames.includes(maintenanceRouteName)
        && maintenanceToken !== undefined
        && options.maintenance.tokenStore.consume(maintenanceToken)
      ) {
        return Promise.resolve();
      }
      throw forbidden();
    }

    const origin = getSingleHeader(originHeader);
    if (origin !== `http://${host}`) {
      throw forbidden();
    }

    const sessionId = readSessionCookie(
      getSingleHeader(request.headers.cookie),
    );
    const csrfToken = getSingleHeader(request.headers['x-csrf-token']);
    if (
      sessionId === undefined
      || csrfToken === undefined
      || !options.sessions.verify(sessionId, csrfToken)
    ) {
      throw forbidden();
    }

    return Promise.resolve();
  });
};
