import { createHash } from 'node:crypto';
import {
  AppError,
  recipePageSchema,
  type RecipePage,
  type RecipeSearchQuery,
} from '@xiaochu/shared';
import {
  RecipeSearchRepository,
  type SearchCursorPosition,
} from './search-repository.js';
import {
  buildFtsMatchExpression,
  compactSearchText,
  normalizeSearchText,
  searchTextLength,
} from './search-tokenizer.js';

interface SerializedSearchCursor {
  readonly scoreKey: number;
  readonly recipeId: string;
  readonly queryHash: string;
  readonly catalogVersion: number;
}

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;
const HASH_PATTERN = /^[\da-f]{64}$/u;
const CURSOR_KEYS = [
  'catalogVersion',
  'queryHash',
  'recipeId',
  'scoreKey',
] as const;

const invalidCursor = (): AppError => new AppError(
  'invalid_cursor',
  '分页游标无效，请从第一页重新加载',
  400,
);

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

const decodeCursor = (value: string): SerializedSearchCursor => {
  try {
    if (!CURSOR_PATTERN.test(value)) {
      throw invalidCursor();
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length === 0 || bytes.length > 768) {
      throw invalidCursor();
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isPlainObject(parsed)) {
      throw invalidCursor();
    }
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== CURSOR_KEYS.length
      || !keys.every((key, index) => key === CURSOR_KEYS[index])
      || typeof parsed.scoreKey !== 'number'
      || !Number.isSafeInteger(parsed.scoreKey)
      || typeof parsed.recipeId !== 'string'
      || parsed.recipeId.length < 1
      || parsed.recipeId.length > 100
      || typeof parsed.queryHash !== 'string'
      || !HASH_PATTERN.test(parsed.queryHash)
      || typeof parsed.catalogVersion !== 'number'
      || !Number.isSafeInteger(parsed.catalogVersion)
      || parsed.catalogVersion < 0
    ) {
      throw invalidCursor();
    }
    return parsed as unknown as SerializedSearchCursor;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidCursor();
  }
};

const encodeCursor = (cursor: SerializedSearchCursor): string => (
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
);

const queryIdentityHash = (query: {
  readonly queryCompact: string;
  readonly difficulty?: RecipeSearchQuery['difficulty'];
  readonly maxMinutes?: number;
  readonly taste?: string;
  readonly technique?: string;
  readonly tier?: RecipeSearchQuery['tier'];
}): string => createHash('sha256').update(JSON.stringify({
  q: query.queryCompact,
  difficulty: query.difficulty ?? null,
  maxMinutes: query.maxMinutes ?? null,
  taste: query.taste ?? null,
  technique: query.technique ?? null,
  tier: query.tier ?? null,
})).digest('hex');

export class RecipeSearchService {
  constructor(private readonly repository: RecipeSearchRepository) {}

  search(query: RecipeSearchQuery): RecipePage {
    const queryCompact = compactSearchText(query.q);
    const queryLength = searchTextLength(query.q);
    const taste = query.taste === undefined
      ? undefined
      : normalizeSearchText(query.taste);
    const technique = query.technique === undefined
      ? undefined
      : normalizeSearchText(query.technique);
    if (taste === '' || technique === '') {
      throw new AppError('validation_error', '筛选条件无效', 400);
    }

    const identity = {
      queryCompact,
      ...(query.difficulty === undefined ? {} : { difficulty: query.difficulty }),
      ...(query.maxMinutes === undefined ? {} : { maxMinutes: query.maxMinutes }),
      ...(taste === undefined ? {} : { taste }),
      ...(technique === undefined ? {} : { technique }),
      ...(query.tier === undefined ? {} : { tier: query.tier }),
    };
    const queryHash = queryIdentityHash(identity);
    const decodedCursor = query.cursor === undefined
      ? undefined
      : decodeCursor(query.cursor);
    if (decodedCursor !== undefined && decodedCursor.queryHash !== queryHash) {
      throw invalidCursor();
    }

    const mode = queryLength === 0
      ? 'browse'
      : queryLength <= 2
        ? 'short'
        : 'fts';
    const ftsExpression = mode === 'fts'
      ? buildFtsMatchExpression(query.q)
      : undefined;
    if (mode === 'fts' && ftsExpression === '') {
      throw new AppError('validation_error', '搜索关键词无效', 400);
    }

    const cursor: SearchCursorPosition | undefined = decodedCursor === undefined
      ? undefined
      : {
          scoreKey: decodedCursor.scoreKey,
          recipeId: decodedCursor.recipeId,
          catalogVersion: decodedCursor.catalogVersion,
        };
    const result = this.repository.searchPage({
      mode,
      ...(ftsExpression === undefined ? {} : { ftsExpression }),
      ...identity,
      ...(cursor === undefined ? {} : { cursor }),
      limit: query.limit,
    });
    const page: RecipePage = {
      items: [...result.items],
      ...(result.nextPosition === undefined ? {} : {
        nextCursor: encodeCursor({
          ...result.nextPosition,
          queryHash,
          catalogVersion: result.catalogVersion,
        }),
      }),
    };
    return recipePageSchema.parse(page);
  }
}
