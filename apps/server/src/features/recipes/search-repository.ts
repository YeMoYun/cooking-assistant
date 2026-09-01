import { AppError, type RecipeCard } from '@xiaochu/shared';
import type Database from 'better-sqlite3';

export interface SearchCursorPosition {
  readonly scoreKey: number;
  readonly recipeId: string;
  readonly catalogVersion: number;
}

export interface RecipeSearchRepositoryRequest {
  readonly mode: 'browse' | 'short' | 'fts';
  readonly queryCompact: string;
  readonly ftsExpression?: string;
  readonly difficulty?: 'easy' | 'medium' | 'hard';
  readonly maxMinutes?: number;
  readonly taste?: string;
  readonly technique?: string;
  readonly tier?: 'standard' | 'video' | 'detailed';
  readonly cursor?: SearchCursorPosition;
  readonly limit: number;
}

export interface RecipeSearchRepositoryPage {
  readonly items: readonly RecipeCard[];
  readonly catalogVersion: number;
  readonly nextPosition?: Omit<SearchCursorPosition, 'catalogVersion'>;
}

interface CatalogVersionRow {
  readonly version: number;
}

interface RecipeSearchRow {
  readonly recipe_id: string;
  readonly title: string;
  readonly summary: string;
  readonly cover_url: string | null;
  readonly total_minutes: number;
  readonly difficulty: 'easy' | 'medium' | 'hard';
  readonly tier: 'standard' | 'video' | 'detailed';
  readonly has_video: number;
  readonly score_key: number;
}

const EXACT_TOKEN = (column: string): string => (
  `instr(' ' || ${column} || ' ', ' ' || @query_compact || ' ') > 0`
);

const TOKEN_PREFIX = (column: string): string => (
  `(substr(${column}, 1, length(@query_compact)) = @query_compact
    OR instr(${column}, ' ' || @query_compact) > 0)`
);

const SHORT_QUERY_SCORE = `CASE
  WHEN rs.title_normalized = @query_compact THEN 0
  WHEN ${EXACT_TOKEN('rs.aliases_normalized')} THEN 100000
  WHEN ${EXACT_TOKEN('rs.title_terms')} THEN 200000
  WHEN ${EXACT_TOKEN('rs.alias_terms')} THEN 300000
  WHEN ${EXACT_TOKEN('rs.ingredient_terms')} THEN 400000
  WHEN ${EXACT_TOKEN('rs.tag_terms')} THEN 500000
  WHEN ${EXACT_TOKEN('rs.summary_terms')} THEN 600000
  WHEN substr(rs.title_normalized, 1, length(@query_compact)) = @query_compact
    THEN 700000
  WHEN ${TOKEN_PREFIX('rs.aliases_normalized')} THEN 800000
  WHEN ${TOKEN_PREFIX('rs.ingredient_terms')} THEN 900000
  WHEN ${TOKEN_PREFIX('rs.tag_terms')} THEN 1000000
  WHEN instr(rs.title_normalized, @query_compact) > 0 THEN 1100000
  WHEN instr(rs.aliases_normalized, @query_compact) > 0 THEN 1200000
  WHEN instr(rs.ingredient_terms, @query_compact) > 0 THEN 1300000
  WHEN instr(rs.tag_terms, @query_compact) > 0 THEN 1400000
  ELSE 1500000
END`;

const BROWSE_SCORE = `CASE rs.tier
  WHEN 'detailed' THEN 0
  WHEN 'video' THEN 1000000
  ELSE 2000000
END`;

const FTS_SCORE = `(
  CAST(ROUND(bm25(recipe_search_fts, 10, 6, 8, 2, 3) * 1000000) AS INTEGER)
  - CASE
      WHEN rs.title_normalized = @query_compact THEN 4000000000
      WHEN ${EXACT_TOKEN('rs.aliases_normalized')} THEN 3000000000
      WHEN substr(rs.title_normalized, 1, length(@query_compact)) = @query_compact
        THEN 2000000000
      WHEN ${TOKEN_PREFIX('rs.aliases_normalized')} THEN 1000000000
      ELSE 0
    END
)`;

const toCard = (row: RecipeSearchRow): RecipeCard => ({
  id: row.recipe_id,
  title: row.title,
  summary: row.summary,
  ...(row.cover_url === null ? {} : {
    coverUrl: `/api/recipe-covers/${row.recipe_id}`,
  }),
  totalMinutes: row.total_minutes,
  difficulty: row.difficulty,
  tier: row.tier,
  hasVideo: row.has_video === 1,
});

const addFilters = (
  request: RecipeSearchRepositoryRequest,
  clauses: string[],
  parameters: Record<string, number | string>,
): void => {
  if (request.difficulty !== undefined) {
    clauses.push('rs.difficulty = @difficulty');
    parameters.difficulty = request.difficulty;
  }
  if (request.maxMinutes !== undefined) {
    clauses.push('rs.total_minutes <= @max_minutes');
    parameters.max_minutes = request.maxMinutes;
  }
  if (request.tier !== undefined) {
    clauses.push('rs.tier = @tier');
    parameters.tier = request.tier;
  }
  if (request.taste !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1 FROM recipe_tags taste_tag
      WHERE taste_tag.recipe_id = r.id
        AND taste_tag.tag_kind = 'taste'
        AND taste_tag.normalized_value = @taste
    )`);
    parameters.taste = request.taste;
  }
  if (request.technique !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1 FROM recipe_tags technique_tag
      WHERE technique_tag.recipe_id = r.id
        AND technique_tag.tag_kind = 'technique'
        AND technique_tag.normalized_value = @technique
    )`);
    parameters.technique = request.technique;
  }
};

const buildSearchSql = (
  request: RecipeSearchRepositoryRequest,
  catalogVersion: number,
): { readonly sql: string; readonly parameters: Record<string, number | string> } => {
  const clauses = [
    'r.is_active = 1',
    'rs.catalog_version = @catalog_version',
  ];
  const parameters: Record<string, number | string> = {
    catalog_version: catalogVersion,
    query_compact: request.queryCompact,
    row_limit: request.limit + 1,
  };
  addFilters(request, clauses, parameters);

  let from = `recipe_search rs
    JOIN recipes r ON r.id = rs.recipe_id`;
  let score = BROWSE_SCORE;
  if (request.mode === 'short') {
    clauses.push(`(
      instr(rs.title_normalized, @query_compact) > 0
      OR instr(rs.aliases_normalized, @query_compact) > 0
      OR instr(rs.title_terms, @query_compact) > 0
      OR instr(rs.ingredient_terms, @query_compact) > 0
      OR instr(rs.alias_terms, @query_compact) > 0
      OR instr(rs.summary_terms, @query_compact) > 0
      OR instr(rs.tag_terms, @query_compact) > 0
    )`);
    score = SHORT_QUERY_SCORE;
  } else if (request.mode === 'fts') {
    from = `recipe_search_fts
      JOIN recipe_search rs ON rs.rowid = recipe_search_fts.rowid
      JOIN recipes r ON r.id = rs.recipe_id`;
    clauses.push('recipe_search_fts MATCH @fts_expression');
    parameters.fts_expression = request.ftsExpression as string;
    score = FTS_SCORE;
  }

  const cursorClause = request.cursor === undefined
    ? ''
    : `WHERE (
        score_key > @cursor_score
        OR (score_key = @cursor_score AND recipe_id > @cursor_recipe_id)
      )`;
  if (request.cursor !== undefined) {
    parameters.cursor_score = request.cursor.scoreKey;
    parameters.cursor_recipe_id = request.cursor.recipeId;
  }

  return {
    sql: `WITH ranked AS (
      SELECT
        r.id AS recipe_id,
        r.title,
        r.summary,
        r.cover_remote_url AS cover_url,
        rs.total_minutes,
        rs.difficulty,
        rs.tier,
        CASE WHEN EXISTS (
          SELECT 1 FROM recipe_media media
          WHERE media.recipe_id = r.id AND media.is_active = 1
        ) THEN 1 ELSE 0 END AS has_video,
        ${score} AS score_key
      FROM ${from}
      WHERE ${clauses.join('\n        AND ')}
    )
    SELECT
      recipe_id, title, summary, cover_url, total_minutes, difficulty, tier,
      has_video, score_key
    FROM ranked
    ${cursorClause}
    ORDER BY score_key ASC, recipe_id ASC
    LIMIT @row_limit`,
    parameters,
  };
};

export class RecipeSearchRepository {
  constructor(private readonly db: Database.Database) {}

  searchPage(request: RecipeSearchRepositoryRequest): RecipeSearchRepositoryPage {
    let transactionOpen = false;
    try {
      this.db.exec('BEGIN');
      transactionOpen = true;
      const versionRow = this.db.prepare(`
        SELECT version FROM app_data_versions WHERE scope = 'recipe_catalog'
      `).get() as CatalogVersionRow | undefined;
      if (versionRow === undefined) {
        throw new AppError(
          'catalog_unavailable',
          '食谱目录尚未准备好',
          503,
        );
      }
      if (
        request.cursor !== undefined
        && request.cursor.catalogVersion !== versionRow.version
      ) {
        throw new AppError(
          'catalog_changed',
          '食谱目录已更新，请从第一页重新加载',
          409,
        );
      }

      const query = buildSearchSql(request, versionRow.version);
      const rows = this.db.prepare(query.sql).all(
        query.parameters,
      ) as RecipeSearchRow[];
      this.db.exec('COMMIT');
      transactionOpen = false;

      const hasNextPage = rows.length > request.limit;
      const pageRows = hasNextPage ? rows.slice(0, request.limit) : rows;
      const lastRow = pageRows.at(-1);
      return {
        items: pageRows.map(toCard),
        catalogVersion: versionRow.version,
        ...(hasNextPage && lastRow !== undefined ? {
          nextPosition: {
            scoreKey: lastRow.score_key,
            recipeId: lastRow.recipe_id,
          },
        } : {}),
      };
    } catch (error) {
      if (transactionOpen) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
  }
}
