import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const SESSION_COOKIE_NAME = 'xiaochu_session';
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;

const TOKEN_BYTES = 32;
const TOKEN_CHARACTERS = 43;
const MAX_SESSION_ID_ATTEMPTS = 8;

export type Clock = () => number;
export type RandomBytes = (size: number) => Buffer;

export interface SessionStoreOptions {
  readonly now?: Clock;
  readonly randomBytes?: RandomBytes;
  readonly ttlMs?: number;
}

export interface CreatedSession {
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly sessionId: string;
}

interface StoredSession {
  readonly csrfHash: Buffer;
  readonly expiresAt: number;
}

const hashToken = (token: string): Buffer => (
  createHash('sha256').update(token, 'utf8').digest()
);

const isOpaqueToken = (token: string): boolean => (
  token.length === TOKEN_CHARACTERS
  && Buffer.byteLength(token, 'utf8') === TOKEN_CHARACTERS
  && /^[A-Za-z0-9_-]+$/u.test(token)
);

export const readSessionIdFromCookieHeader = (
  cookieHeader: string | undefined,
): string | undefined => {
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

  const value = matches[0]?.slice(prefix.length);
  return value !== undefined && isOpaqueToken(value) ? value : undefined;
};

export class MemorySessionStore {
  readonly #now: Clock;
  readonly #randomBytes: RandomBytes;
  readonly #sessions = new Map<string, StoredSession>();
  readonly #ttlMs: number;

  constructor(options: SessionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;

    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new TypeError('Session TTL must be a positive integer');
    }
  }

  create(): CreatedSession {
    const now = this.#now();
    this.#pruneExpired(now);

    for (let attempt = 0; attempt < MAX_SESSION_ID_ATTEMPTS; attempt += 1) {
      const sessionId = this.#createToken();
      if (this.#sessions.has(sessionId)) {
        continue;
      }

      const csrfToken = this.#createToken();
      const expiresAt = now + this.#ttlMs;
      this.#sessions.set(sessionId, {
        csrfHash: hashToken(csrfToken),
        expiresAt,
      });
      return { csrfToken, expiresAt, sessionId };
    }

    throw new Error('Unable to allocate a unique session');
  }

  verify(sessionId: string, csrfToken: string): boolean {
    if (!isOpaqueToken(sessionId) || !isOpaqueToken(csrfToken)) {
      return false;
    }

    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return false;
    }

    if (this.#now() >= session.expiresAt) {
      this.#sessions.delete(sessionId);
      return false;
    }

    const candidateHash = hashToken(csrfToken);
    return candidateHash.length === session.csrfHash.length
      && timingSafeEqual(candidateHash, session.csrfHash);
  }

  clear(): void {
    for (const session of this.#sessions.values()) {
      session.csrfHash.fill(0);
    }
    this.#sessions.clear();
  }

  #createToken(): string {
    const bytes = this.#randomBytes(TOKEN_BYTES);
    if (bytes.length !== TOKEN_BYTES) {
      throw new TypeError('Random byte source returned an invalid length');
    }
    return bytes.toString('base64url');
  }

  #pruneExpired(now: number): void {
    for (const [sessionId, session] of this.#sessions) {
      if (now >= session.expiresAt) {
        this.#sessions.delete(sessionId);
      }
    }
  }
}
