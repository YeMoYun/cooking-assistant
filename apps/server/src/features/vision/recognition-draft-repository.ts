import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  AppError,
  confirmRecognitionInputSchema,
  confirmRecognitionResultSchema,
  inventoryItemSchema,
  recognitionPreviewSchema,
  toBaseQuantity,
  type ConfirmRecognitionItem,
  type ConfirmRecognitionResult,
  type InventoryItem,
  type KitchenCategory,
  type RecognitionPreview,
  type Unit,
  type VisionCandidate,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';

export const RECOGNITION_DRAFT_TTL_MS = 5 * 60 * 1_000;
const TOKEN_BYTES = 32;
const MAX_TOKEN_ATTEMPTS = 8;

interface RecognitionDraftRow {
  readonly id: string;
  readonly session_binding_hash: string;
  readonly candidates_json: string;
  readonly inventory_version: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

interface IngredientMatchRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly category: KitchenCategory;
}

export interface RecognitionDraftRepositoryOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomUUID?: () => string;
  readonly ttlMs?: number;
}

export interface CreateRecognitionDraftInput {
  readonly candidates: readonly VisionCandidate[];
  readonly sessionId: string;
}

export interface ConfirmRecognitionDraftInput {
  readonly recognitionId: string;
  readonly sessionId: string;
  readonly items: readonly ConfirmRecognitionItem[];
}

const normalizeName = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}\s]+/gu, ' ')
  .trim();

const displayName = (value: string): string => value
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim();

const hashSession = (sessionId: string): string => createHash('sha256')
  .update(sessionId, 'utf8')
  .digest('hex');

const sessionMatches = (stored: string, sessionId: string): boolean => {
  const left = Buffer.from(stored, 'hex');
  const right = Buffer.from(hashSession(sessionId), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};

const requireSessionId = (sessionId: string): void => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(sessionId)) {
    throw new AppError('forbidden', 'Request forbidden', 403);
  }
};

const isPrimaryKeyCollision = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
);

const parseCandidates = (value: string): VisionCandidate[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return recognitionPreviewSchema.shape.candidates.parse(parsed);
  } catch {
    throw new Error('Stored recognition candidates are invalid');
  }
};

export class RecognitionDraftRepository {
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #randomUUID: () => string;
  readonly #ttlMs: number;

  constructor(
    private readonly db: Database.Database,
    options: RecognitionDraftRepositoryOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#ttlMs = options.ttlMs ?? RECOGNITION_DRAFT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new TypeError('Recognition draft TTL must be positive');
    }
  }

  create(input: CreateRecognitionDraftInput): RecognitionPreview {
    requireSessionId(input.sessionId);
    const candidates = recognitionPreviewSchema.shape.candidates.parse(
      input.candidates,
    );
    const candidatesJson = JSON.stringify(candidates);
    if (Buffer.byteLength(candidatesJson, 'utf8') > 1_000_000) {
      throw new AppError(
        'vision_result_too_large',
        '识别结果过多，请缩小拍摄范围后重试',
        502,
      );
    }

    const create = this.db.transaction(() => {
      const inventoryVersion = this.#getInventoryVersion();
      const createdAtMs = this.#now();
      const createdAt = new Date(createdAtMs).toISOString();
      const expiresAt = new Date(createdAtMs + this.#ttlMs).toISOString();
      for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
        const bytes = this.#randomBytes(TOKEN_BYTES);
        if (bytes.length !== TOKEN_BYTES) {
          throw new TypeError('Random byte source returned an invalid length');
        }
        const recognitionId = bytes.toString('base64url');
        try {
          this.db.prepare(`
            INSERT INTO recognition_drafts(
              id, session_binding_hash, candidates_json, inventory_version,
              created_at, expires_at, consumed_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
          `).run(
            recognitionId,
            hashSession(input.sessionId),
            candidatesJson,
            inventoryVersion,
            createdAt,
            expiresAt,
          );
          return recognitionPreviewSchema.parse({
            recognitionId,
            expiresAt,
            candidates,
          });
        } catch (error) {
          if (!isPrimaryKeyCollision(error)) {
            throw error;
          }
        }
      }
      throw new Error('Unable to allocate a recognition draft ID');
    });
    return create.immediate();
  }

  confirm(input: ConfirmRecognitionDraftInput): ConfirmRecognitionResult {
    requireSessionId(input.sessionId);
    const edited = confirmRecognitionInputSchema.parse({ items: input.items });
    const confirm = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT
          id, session_binding_hash, candidates_json, inventory_version,
          created_at, expires_at, consumed_at
        FROM recognition_drafts WHERE id = ?
      `).get(input.recognitionId) as RecognitionDraftRow | undefined;
      if (row === undefined) {
        throw new AppError(
          'recognition_not_found',
          '识别确认记录不存在',
          404,
        );
      }
      if (!sessionMatches(row.session_binding_hash, input.sessionId)) {
        throw new AppError('forbidden', 'Request forbidden', 403);
      }
      if (row.consumed_at !== null) {
        throw new AppError(
          'recognition_used',
          '这次识别结果已经确认，不能重复提交',
          409,
        );
      }
      const nowMs = this.#now();
      if (nowMs >= Date.parse(row.expires_at)) {
        throw new AppError(
          'recognition_expired',
          '识别结果已过期，请重新拍照或手动添加',
          410,
        );
      }
      // Parsing on confirmation detects storage corruption without trusting it
      // as the inventory write source. Only edited.items is inserted below.
      parseCandidates(row.candidates_json);
      if (this.#getInventoryVersion() !== row.inventory_version) {
        throw new AppError(
          'data_changed',
          '冰箱库存已变化，请重新检查识别结果',
          409,
        );
      }

      const now = new Date(nowMs).toISOString();
      const inserted: InventoryItem[] = [];
      for (const item of edited.items) {
        inserted.push(this.#insertEditedItem(item, now));
      }
      const bump = this.db.prepare(`
        UPDATE app_data_versions SET version = version + 1
        WHERE scope = 'inventory'
      `).run();
      if (bump.changes !== 1) {
        throw new Error('Missing inventory data version');
      }
      const consume = this.db.prepare(`
        UPDATE recognition_drafts SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL
      `).run(now, row.id);
      if (consume.changes !== 1) {
        throw new AppError(
          'recognition_used',
          '这次识别结果已经确认，不能重复提交',
          409,
        );
      }

      return confirmRecognitionResultSchema.parse({
        inventoryVersion: this.#getInventoryVersion(),
        items: inserted,
      });
    });
    return confirm.immediate();
  }

  #insertEditedItem(
    item: ConfirmRecognitionItem,
    now: string,
  ): InventoryItem {
    const normalizedInput = normalizeName(item.name);
    if (normalizedInput.length === 0) {
      throw new AppError('validation_error', '食材名称无效', 400);
    }
    const matches = this.db.prepare(`
      SELECT id, canonical_name, normalized_name, category
      FROM ingredients
      WHERE is_active = 1 AND normalized_name = ?
      UNION
      SELECT i.id, i.canonical_name, i.normalized_name, i.category
      FROM ingredient_aliases a
      JOIN ingredients i ON i.id = a.ingredient_id
      WHERE i.is_active = 1 AND a.normalized_alias = ?
      LIMIT 2
    `).all(normalizedInput, normalizedInput) as IngredientMatchRow[];
    const match = matches.length === 1 ? matches[0] : undefined;
    const stored = toBaseQuantity(item.quantity, item.unit);
    const id = this.#randomUUID();
    const name = match?.canonical_name ?? displayName(item.name);
    const normalizedName = match?.normalized_name ?? normalizedInput;
    const category = match?.category ?? item.category;
    this.db.prepare(`
      INSERT INTO inventory_items(
        id, ingredient_id, canonical_name, normalized_name, quantity, unit,
        category, source, confirmed_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'vision', ?, ?, ?, 1)
    `).run(
      id,
      match?.id ?? null,
      name,
      normalizedName,
      stored.quantity,
      stored.unit,
      category,
      now,
      now,
      now,
    );
    return inventoryItemSchema.parse({
      id,
      ingredientId: match?.id ?? null,
      name,
      quantity: stored.quantity,
      unit: stored.unit as Unit,
      category,
      source: 'vision',
      confirmedAt: now,
      updatedAt: now,
      version: 1,
    });
  }

  #getInventoryVersion(): number {
    const row = this.db.prepare(`
      SELECT version FROM app_data_versions WHERE scope = 'inventory'
    `).get() as { readonly version: number } | undefined;
    if (row === undefined) {
      throw new Error('Missing inventory data version');
    }
    return row.version;
  }
}
