import { AppError, type ApiProblem } from '@xiaochu/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

type PublicDetail = (
  null
  | boolean
  | number
  | string
  | PublicDetail[]
  | { [key: string]: PublicDetail }
);

type DetailCloneResult = (
  { readonly ok: true; readonly value: PublicDetail }
  | { readonly ok: false }
);

interface DetailCloneState {
  entries: number;
  readonly seen: WeakSet<object>;
}

const MAX_DETAILS_DEPTH = 5;
const MAX_DETAILS_ENTRIES = 100;
const MAX_DETAILS_BYTES = 4_096;
const UNSAFE_DETAIL: DetailCloneResult = { ok: false };
const SENSITIVE_KEY_FRAGMENTS = [
  'authorization',
  'apikey',
  'token',
  'secret',
  'password',
  'credential',
  'cookie',
  'stack',
  'response',
  'body',
] as const;

const isSafeDetailKey = (key: string): boolean => {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return false;
  }

  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return normalizedKey.length > 0 && !SENSITIVE_KEY_FRAGMENTS.some(
    (fragment) => normalizedKey.includes(fragment),
  );
};

const reserveDetailEntries = (
  state: DetailCloneState,
  count: number,
): boolean => {
  state.entries += count;
  return state.entries <= MAX_DETAILS_ENTRIES;
};

const clonePublicDetail = (
  value: unknown,
  depth: number,
  state: DetailCloneState,
): DetailCloneResult => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value };
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : UNSAFE_DETAIL;
  }

  if (typeof value !== 'object' || depth > MAX_DETAILS_DEPTH) {
    return UNSAFE_DETAIL;
  }

  if (state.seen.has(value)) {
    return UNSAFE_DETAIL;
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== value.length + 1
      || !reserveDetailEntries(state, value.length)
    ) {
      return UNSAFE_DETAIL;
    }

    const clone: PublicDetail[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        return UNSAFE_DETAIL;
      }

      const item = clonePublicDetail(descriptor.value, depth + 1, state);
      if (!item.ok) {
        return UNSAFE_DETAIL;
      }
      clone.push(item.value);
    }
    return { ok: true, value: clone };
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return UNSAFE_DETAIL;
  }

  const enumerableKeys = Object.keys(value);
  if (
    Reflect.ownKeys(value).length !== enumerableKeys.length
    || !reserveDetailEntries(state, enumerableKeys.length)
  ) {
    return UNSAFE_DETAIL;
  }

  const cloneEntries: Array<[string, PublicDetail]> = [];
  for (const key of enumerableKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !isSafeDetailKey(key)
      || descriptor === undefined
      || !('value' in descriptor)
    ) {
      return UNSAFE_DETAIL;
    }

    const item = clonePublicDetail(descriptor.value, depth + 1, state);
    if (!item.ok) {
      return UNSAFE_DETAIL;
    }
    cloneEntries.push([key, item.value]);
  }

  return { ok: true, value: Object.fromEntries(cloneEntries) };
};

const getPublicDetails = (details: unknown): PublicDetail | undefined => {
  try {
    const result = clonePublicDetail(details, 0, {
      entries: 0,
      seen: new WeakSet<object>(),
    });
    if (!result.ok) {
      return undefined;
    }

    const serialized = JSON.stringify(result.value);
    return Buffer.byteLength(serialized, 'utf8') <= MAX_DETAILS_BYTES
      ? result.value
      : undefined;
  } catch {
    return undefined;
  }
};

const isValidationError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return (
    ('validation' in error && Array.isArray(error.validation))
    || ('code' in error && error.code === 'FST_ERR_VALIDATION')
  );
};

const isValidErrorStatusCode = (statusCode: number): boolean => (
  Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
);

export const errorHandler = (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void => {
  const isKnownAppError = error instanceof AppError;
  if (isKnownAppError && isValidErrorStatusCode(error.statusCode)) {
    const details = getPublicDetails(error.details);
    const problem: ApiProblem = {
      error: {
        code: error.code,
        message: error.message,
        requestId: request.id,
        ...(details === undefined ? {} : { details }),
      },
    };

    reply.status(error.statusCode).send(problem);
    return;
  }

  if (!isKnownAppError && isValidationError(error)) {
    const problem: ApiProblem = {
      error: {
        code: 'validation_error',
        message: '请求参数无效',
        requestId: request.id,
      },
    };

    reply.status(400).send(problem);
    return;
  }

  const problem: ApiProblem = {
    error: {
      code: 'internal_error',
      message: '服务器内部错误',
      requestId: request.id,
    },
  };

  reply.status(500).send(problem);
};
