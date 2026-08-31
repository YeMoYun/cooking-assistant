import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalJsonHash } from './canonical-json.js';

export const PENDING_ACTION_TTL_MS = 5 * 60 * 1_000;
const TOKEN_BYTES = 32;
const MAX_TOKEN_ATTEMPTS = 8;

type PendingActionKind = 'shopping_items' | 'recipe_variant' | 'note';

interface PendingActionRow {
  readonly id: string;
  readonly action_kind: PendingActionKind;
  readonly tool_name: string;
  readonly payload_json: string;
  readonly arguments_hash: string;
  readonly session_binding_hash: string;
  readonly data_versions_json: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

interface StoredPayload {
  readonly arguments: unknown;
  readonly payload: unknown;
}

export interface IssuePendingActionInput {
  readonly kind: PendingActionKind;
  readonly toolName: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly arguments: unknown;
  readonly payload: unknown;
  readonly expectedDataVersions: Readonly<Record<string, number>>;
  readonly primaryVersionScope: string;
}

export interface IssuedPendingAction {
  readonly pendingActionId: string;
  readonly expiresAt: string;
}

export interface ConfirmPendingActionInput<TPayload, TResult> {
  readonly pendingActionId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly arguments?: unknown;
  readonly parsePayload: (value: unknown) => TPayload;
  readonly execute: (payload: TPayload) => TResult;
}

export interface PendingActionServiceOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly ttlMs?: number;
}

export interface PendingActionIdentity {
  readonly kind: PendingActionKind;
  readonly toolName: string;
}

const sessionBindingHash = (sessionId: string): string => createHash('sha256')
  .update(sessionId, 'utf8')
  .digest('hex');

const hashesEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
};

const parseDataVersions = (value: string): Record<string, number> => {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error('Invalid pending action version snapshot');
  }
  const versions: Record<string, number> = {};
  for (const [scope, version] of Object.entries(parsed)) {
    if (
      scope.length < 1
      || scope.length > 100
      || !Number.isSafeInteger(version)
      || (version as number) < 0
    ) {
      throw new Error('Invalid pending action version snapshot');
    }
    versions[scope] = version as number;
  }
  if (Object.keys(versions).length === 0) {
    throw new Error('Pending action requires a data version');
  }
  return versions;
};

const parseStoredPayload = (value: string): StoredPayload => {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== 2
    || !('arguments' in parsed)
    || !('payload' in parsed)
  ) {
    throw new Error('Invalid pending action payload');
  }
  return {
    arguments: parsed.arguments,
    payload: parsed.payload,
  };
};

export class PendingActionService {
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #ttlMs: number;

  constructor(
    private readonly db: Database.Database,
    options: PendingActionServiceOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#ttlMs = options.ttlMs ?? PENDING_ACTION_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new TypeError('Pending action TTL must be a positive integer');
    }
  }

  issue(input: IssuePendingActionInput): IssuedPendingAction {
    const versions = { ...input.expectedDataVersions };
    const primaryVersion = versions[input.primaryVersionScope];
    if (
      primaryVersion === undefined
      || !Number.isSafeInteger(primaryVersion)
      || primaryVersion < 0
    ) {
      throw new TypeError('Primary pending action version is missing');
    }
    for (const [scope, version] of Object.entries(versions)) {
      if (
        scope.length < 1
        || scope.length > 100
        || !Number.isSafeInteger(version)
        || version < 0
      ) {
        throw new TypeError('Invalid pending action data version');
      }
    }

    const createdAtMs = this.#now();
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + this.#ttlMs).toISOString();
    const storedPayload = canonicalJson({
      arguments: input.arguments,
      payload: input.payload,
    });
    const argumentsHash = canonicalJsonHash(input.arguments);
    const versionsJson = canonicalJson(versions);

    const insert = this.db.transaction(() => {
      this.#assertCurrentVersions(versions);
      for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
        const bytes = this.#randomBytes(TOKEN_BYTES);
        if (bytes.length !== TOKEN_BYTES) {
          throw new TypeError('Random byte source returned an invalid length');
        }
        const pendingActionId = bytes.toString('base64url');
        try {
          this.db.prepare(`
            INSERT INTO pending_actions(
              id, action_kind, tool_name, payload_json, arguments_hash,
              session_binding_hash, turn_id, data_version_scope,
              data_version_value, data_versions_json, created_at, expires_at,
              consumed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `).run(
            pendingActionId,
            input.kind,
            input.toolName,
            storedPayload,
            argumentsHash,
            sessionBindingHash(input.sessionId),
            input.turnId ?? null,
            input.primaryVersionScope,
            primaryVersion,
            versionsJson,
            createdAt,
            expiresAt,
          );
          return { pendingActionId, expiresAt };
        } catch (error) {
          if (
            typeof error !== 'object'
            || error === null
            || !('code' in error)
            || error.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY'
          ) {
            throw error;
          }
        }
      }
      throw new Error('Unable to allocate a pending action ID');
    });
    return insert.immediate();
  }

  confirm<TPayload, TResult>(
    input: ConfirmPendingActionInput<TPayload, TResult>,
  ): TResult {
    const confirm = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT
          id, action_kind, tool_name, payload_json, arguments_hash,
          session_binding_hash, data_versions_json, expires_at, consumed_at
        FROM pending_actions WHERE id = ?
      `).get(input.pendingActionId) as PendingActionRow | undefined;
      if (row === undefined) {
        throw new AppError(
          'pending_action_not_found',
          '待确认操作不存在',
          404,
        );
      }
      if (row.consumed_at !== null) {
        throw new AppError(
          'pending_action_used',
          '该操作已经确认，不能重复执行',
          409,
        );
      }
      const nowMs = this.#now();
      if (nowMs >= Date.parse(row.expires_at)) {
        throw new AppError(
          'pending_action_expired',
          '确认已过期，请重新生成预览',
          410,
        );
      }
      if (
        row.tool_name !== input.toolName
        || !hashesEqual(
          row.session_binding_hash,
          sessionBindingHash(input.sessionId),
        )
      ) {
        throw new AppError('forbidden', 'Request forbidden', 403);
      }

      const stored = parseStoredPayload(row.payload_json);
      if (!hashesEqual(row.arguments_hash, canonicalJsonHash(stored.arguments))) {
        throw new AppError(
          'pending_action_mismatch',
          '待确认操作内容不匹配',
          409,
        );
      }
      if (
        input.arguments !== undefined
        && !hashesEqual(row.arguments_hash, canonicalJsonHash(input.arguments))
      ) {
        throw new AppError(
          'pending_action_mismatch',
          '待确认操作参数已变化',
          409,
        );
      }
      this.#assertCurrentVersions(parseDataVersions(row.data_versions_json));

      const result = input.execute(input.parsePayload(stored.payload));
      const consumedAt = new Date(nowMs).toISOString();
      const update = this.db.prepare(`
        UPDATE pending_actions SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL
      `).run(consumedAt, row.id);
      if (update.changes !== 1) {
        throw new AppError(
          'pending_action_used',
          '该操作已经确认，不能重复执行',
          409,
        );
      }
      return result;
    });
    return confirm.immediate();
  }

  inspect(pendingActionId: string, sessionId: string): PendingActionIdentity {
    const read = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT action_kind, tool_name, session_binding_hash, expires_at, consumed_at
        FROM pending_actions WHERE id = ?
      `).get(pendingActionId) as Pick<PendingActionRow,
        'action_kind' | 'tool_name' | 'session_binding_hash' | 'expires_at' | 'consumed_at'
      > | undefined;
      if (row === undefined) {
        throw new AppError('pending_action_not_found', 'Pending action was not found', 404);
      }
      if (!hashesEqual(row.session_binding_hash, sessionBindingHash(sessionId))) {
        throw new AppError('forbidden', 'Request forbidden', 403);
      }
      if (row.consumed_at !== null) {
        throw new AppError('pending_action_used', 'Pending action was already handled', 409);
      }
      if (this.#now() >= Date.parse(row.expires_at)) {
        throw new AppError('pending_action_expired', 'Pending action has expired', 410);
      }
      return { kind: row.action_kind, toolName: row.tool_name };
    });
    return read.deferred();
  }

  reject(pendingActionId: string, sessionId: string): void {
    const reject = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT session_binding_hash, expires_at, consumed_at
        FROM pending_actions WHERE id = ?
      `).get(pendingActionId) as Pick<PendingActionRow,
        'session_binding_hash' | 'expires_at' | 'consumed_at'
      > | undefined;
      if (row === undefined) {
        throw new AppError('pending_action_not_found', 'Pending action was not found', 404);
      }
      if (!hashesEqual(row.session_binding_hash, sessionBindingHash(sessionId))) {
        throw new AppError('forbidden', 'Request forbidden', 403);
      }
      if (row.consumed_at !== null) {
        throw new AppError('pending_action_used', 'Pending action was already handled', 409);
      }
      if (this.#now() >= Date.parse(row.expires_at)) {
        throw new AppError('pending_action_expired', 'Pending action has expired', 410);
      }
      const result = this.db.prepare(`
        UPDATE pending_actions SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL
      `).run(new Date(this.#now()).toISOString(), pendingActionId);
      if (result.changes !== 1) {
        throw new AppError('pending_action_used', 'Pending action was already handled', 409);
      }
    });
    reject.immediate();
  }

  #assertCurrentVersions(expected: Readonly<Record<string, number>>): void {
    const scopes = Object.keys(expected);
    const placeholders = scopes.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT scope, version FROM app_data_versions
      WHERE scope IN (${placeholders})
    `).all(...scopes) as Array<{ readonly scope: string; readonly version: number }>;
    const actual = new Map(rows.map((row) => [row.scope, row.version]));
    const changed = scopes.some((scope) => actual.get(scope) !== expected[scope]);
    if (changed || rows.length !== scopes.length) {
      throw new AppError(
        'data_changed',
        '相关数据已变化，请重新生成预览',
        409,
      );
    }
  }
}
