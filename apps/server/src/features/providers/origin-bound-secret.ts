import type { SecretStore } from './secret-store.js';

const BINDING_VERSION = 1;
const MAX_BOUND_SECRET_BYTES = 100_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface BoundSecretEnvelope {
  readonly version: typeof BINDING_VERSION;
  readonly origin: string;
  readonly secret: string;
}

const normalizeOrigin = (origin: string): string => {
  const parsed = new URL(origin);
  if (
    parsed.origin !== origin
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error('Provider secret origin is invalid');
  }
  return parsed.origin;
};

export const putOriginBoundSecret = async (
  secretStore: SecretStore,
  secret: string,
  origin: string,
): Promise<string> => {
  const secretBytes = Buffer.from(secret, 'utf8');
  try {
    const envelope: BoundSecretEnvelope = {
      version: BINDING_VERSION,
      origin: normalizeOrigin(origin),
      secret: secretBytes.toString('base64'),
    };
    return await secretStore.put(JSON.stringify(envelope));
  } finally {
    secretBytes.fill(0);
  }
};

export const getOriginBoundSecret = async (
  secretStore: SecretStore,
  keyRef: string,
  origin: string,
): Promise<string> => {
  const raw = await secretStore.get(keyRef);
  if (Buffer.byteLength(raw, 'utf8') > MAX_BOUND_SECRET_BYTES) {
    throw new Error('Provider secret binding is invalid');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Provider secret binding is invalid');
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('version' in parsed)
    || parsed.version !== BINDING_VERSION
    || !('origin' in parsed)
    || typeof parsed.origin !== 'string'
    || !('secret' in parsed)
    || typeof parsed.secret !== 'string'
    || parsed.secret.length > MAX_BOUND_SECRET_BYTES
    || !BASE64_PATTERN.test(parsed.secret)
    || parsed.origin !== normalizeOrigin(origin)
  ) {
    throw new Error('Provider secret binding is invalid');
  }

  const secretBytes = Buffer.from(parsed.secret, 'base64');
  try {
    return secretBytes.toString('utf8');
  } finally {
    secretBytes.fill(0);
  }
};
