import type Database from 'better-sqlite3';
import { safeCanonicalizeRecipe } from './canonical-recipe.js';
import {
  appendImportError,
  createImportReport,
  finishImportReport,
  sanitizeSourceKey,
  type ImportMode,
  type ImportReport,
} from './import-report.js';
import {
  normalizeLookupText,
  normalizeRecipe,
  RecipeNormalizationError,
  type NormalizedRecipe,
} from './normalize-recipe.js';
import { readJsonl } from './read-jsonl.js';

export type RecipeImportDisposition = 'inserted' | 'updated' | 'unchanged' | 'reactivated';

export type ImportLifecycleEvent =
  | { readonly event: 'before-cutover'; readonly accepted: number }
  | {
    readonly event: 'after-recipe';
    readonly index: number;
    readonly sourceKey: string;
    readonly disposition: RecipeImportDisposition;
  }
  | { readonly event: 'before-integrity-check' }
  | { readonly event: 'before-commit' };

export interface ImportLifecycleHooks {
  /** A synchronous observability/fault-injection seam; throwing rolls Phase B back. */
  readonly onEvent?: (event: ImportLifecycleEvent) => void;
}

export interface ImportRecipeCatalogOptions {
  readonly db: Database.Database;
  readonly inputPath: string;
  readonly mode: ImportMode;
  readonly maximumLineBytes?: number;
  readonly hooks?: ImportLifecycleHooks;
  readonly now?: () => Date;
}

export class CatalogImportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CatalogImportError';
    this.code = code;
  }
}

interface StageRow {
  readonly line: number;
  readonly source_key: string;
  readonly canonical_json: string;
}

interface ExistingRecipe {
  readonly id: string;
  readonly content_hash: string;
  readonly is_active: 0 | 1;
}

interface MediaHealthRow {
  readonly id: string;
  readonly health_status: string;
  readonly last_checked_at: string | null;
  readonly last_healthy_at: string | null;
  readonly failure_code: string | null;
}

interface AliasClaim {
  readonly ingredientId: string;
  readonly category?: string;
}

const issuePath = (path: readonly PropertyKey[]): string => {
  if (path.length === 0) {
    return '$';
  }
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
    } else if (typeof segment === 'string' && /^[A-Za-z_$][\w$]*$/u.test(segment)) {
      result += result.length === 0 ? segment : `.${segment}`;
    } else {
      return '$';
    }
  }
  return result;
};

const rawSourceKey = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return sanitizeSourceKey((value as Record<string, unknown>).sourceKey);
};

const createStageTable = (db: Database.Database): void => {
  db.exec(`
    DROP TABLE IF EXISTS temp.recipe_import_stage;
    CREATE TEMP TABLE recipe_import_stage (
      line INTEGER NOT NULL PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      tier TEXT NOT NULL,
      canonical_json TEXT NOT NULL
    ) STRICT;
  `);
};

const assertAliasClaim = (
  claims: Map<string, AliasClaim>,
  name: string,
  claim: AliasClaim,
): void => {
  const key = normalizeLookupText(name);
  if (key.length === 0) {
    throw new CatalogImportError('empty_ingredient_alias');
  }
  const existing = claims.get(key);
  if (existing !== undefined && existing.ingredientId !== claim.ingredientId) {
    throw new CatalogImportError('ingredient_alias_ownership_conflict');
  }
  if (
    existing?.category !== undefined
    && claim.category !== undefined
    && existing.category !== claim.category
  ) {
    throw new CatalogImportError('ingredient_category_conflict');
  }
  const category = existing?.category ?? claim.category;
  claims.set(key, {
    ingredientId: claim.ingredientId,
    ...(category === undefined ? {} : { category }),
  });
};

const validateCatalogAliasOwnership = (
  db: Database.Database,
  mode: ImportMode,
  recipes: readonly NormalizedRecipe[],
): void => {
  const claims = new Map<string, AliasClaim>();
  if (mode === 'merge') {
    const existingNames = db.prepare(`
      SELECT i.normalized_name AS name, i.id AS ingredient_id, i.category
      FROM recipe_ingredients ri
      JOIN recipes r ON r.id = ri.recipe_id AND r.is_active = 1
      JOIN ingredients i ON i.id = ri.ingredient_id
      WHERE r.source_key NOT IN (SELECT source_key FROM temp.recipe_import_stage)
      UNION ALL
      SELECT s.normalized_alias AS name, s.ingredient_id, NULL AS category
      FROM recipe_ingredient_alias_sources s
      JOIN recipes r ON r.id = s.recipe_id AND r.is_active = 1
      WHERE r.source_key NOT IN (SELECT source_key FROM temp.recipe_import_stage)
      ORDER BY name, ingredient_id
    `).all() as Array<{ name: string; ingredient_id: string; category: string | null }>;
    for (const existing of existingNames) {
      assertAliasClaim(claims, existing.name, {
        ingredientId: existing.ingredient_id,
        ...(existing.category === null ? {} : { category: existing.category }),
      });
    }
  }

  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      const claim = { ingredientId: ingredient.id, category: ingredient.category };
      assertAliasClaim(claims, ingredient.normalizedName, claim);
      for (const alias of ingredient.aliases) {
        assertAliasClaim(claims, alias.normalizedAlias, { ingredientId: ingredient.id });
      }
    }
  }
};

const restoreMedia = (
  db: Database.Database,
  recipe: NormalizedRecipe,
  recipeId: string,
): void => {
  const health = new Map((db.prepare(`
    SELECT id, health_status, last_checked_at, last_healthy_at, failure_code
    FROM recipe_media WHERE recipe_id = ?
  `).all(recipeId) as MediaHealthRow[]).map((row) => [row.id, row]));
  db.prepare('DELETE FROM recipe_media WHERE recipe_id = ?').run(recipeId);
  const insert = db.prepare(`
    INSERT INTO recipe_media (
      id, recipe_id, position, kind, url, provider, poster_url,
      health_status, last_checked_at, last_healthy_at, failure_code, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const media of recipe.media) {
    const previous = health.get(media.id);
    insert.run(
      media.id,
      recipeId,
      media.position,
      media.kind,
      media.url,
      media.provider,
      media.posterUrl ?? null,
      previous?.health_status ?? 'unchecked',
      previous?.last_checked_at ?? null,
      previous?.last_healthy_at ?? null,
      previous?.failure_code ?? null,
    );
  }
};

const replaceChildren = (
  db: Database.Database,
  recipe: NormalizedRecipe,
  recipeId: string,
  timestamp: string,
): void => {
  const deleteByRecipe = [
    'recipe_steps',
    'recipe_ingredients',
    'recipe_tags',
    'recipe_ingredient_alias_sources',
  ] as const;
  for (const table of deleteByRecipe) {
    db.prepare(`DELETE FROM ${table} WHERE recipe_id = ?`).run(recipeId);
  }
  restoreMedia(db, recipe, recipeId);

  const upsertIngredient = db.prepare(`
    INSERT INTO ingredients (
      id, canonical_name, normalized_name, category, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      canonical_name = excluded.canonical_name,
      normalized_name = excluded.normalized_name,
      category = excluded.category,
      is_active = 1,
      updated_at = excluded.updated_at
  `);
  const insertRecipeIngredient = db.prepare(`
    INSERT INTO recipe_ingredients (
      id, recipe_id, ingredient_id, position, quantity, unit, is_optional, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAliasSource = db.prepare(`
    INSERT INTO recipe_ingredient_alias_sources (
      recipe_id, ingredient_id, alias_id, alias, normalized_alias, position
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const ingredient of recipe.ingredients) {
    upsertIngredient.run(
      ingredient.id,
      ingredient.canonicalName,
      ingredient.normalizedName,
      ingredient.category,
      timestamp,
      timestamp,
    );
    insertRecipeIngredient.run(
      ingredient.recipeIngredientId,
      recipeId,
      ingredient.id,
      ingredient.position,
      ingredient.quantity,
      ingredient.unit,
      ingredient.optional ? 1 : 0,
      ingredient.note ?? null,
    );
    for (const alias of ingredient.aliases) {
      insertAliasSource.run(
        recipeId,
        ingredient.id,
        alias.id,
        alias.alias,
        alias.normalizedAlias,
        alias.position,
      );
    }
  }

  const insertStep = db.prepare(`
    INSERT INTO recipe_steps (
      id, recipe_id, step_number, instruction, duration_seconds_min,
      duration_seconds_max, heat_or_device, completion_cue, common_mistake,
      safety_requirement
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStepIngredient = db.prepare(`
    INSERT INTO recipe_step_ingredients (
      recipe_id, recipe_step_id, recipe_ingredient_id, position
    ) VALUES (?, ?, ?, ?)
  `);
  for (const step of recipe.steps) {
    insertStep.run(
      step.id,
      recipeId,
      step.number,
      step.instruction,
      step.durationSecondsMin ?? null,
      step.durationSecondsMax ?? null,
      step.heatOrDevice ?? null,
      step.completionCue ?? null,
      step.commonMistake ?? null,
      step.safetyRequirement ?? null,
    );
    step.recipeIngredientIds.forEach((recipeIngredientId, position) => {
      insertStepIngredient.run(recipeId, step.id, recipeIngredientId, position);
    });
  }

  const insertTag = db.prepare(`
    INSERT INTO recipe_tags (
      id, recipe_id, tag_kind, value, normalized_value, position
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const tag of recipe.normalizedTags) {
    insertTag.run(tag.id, recipeId, tag.kind, tag.value, tag.normalizedValue, tag.position);
  }
};

const writeRecipe = (
  db: Database.Database,
  recipe: NormalizedRecipe,
  timestamp: string,
): { readonly recipeId: string; readonly disposition: RecipeImportDisposition } => {
  const existing = db.prepare(`
    SELECT id, content_hash, is_active FROM recipes WHERE source_key = ?
  `).get(recipe.sourceKey) as ExistingRecipe | undefined;
  const disposition: RecipeImportDisposition = existing === undefined
    ? 'inserted'
    : existing.is_active === 0
      ? 'reactivated'
      : existing.content_hash === recipe.contentHash
        ? 'unchanged'
        : 'updated';
  const recipeId = existing?.id ?? recipe.id;

  if (existing === undefined) {
    db.prepare(`
      INSERT INTO recipes (
        id, source_key, content_version, content_hash, schema_version, title,
        aliases_json, summary, tier, difficulty, servings, prep_minutes,
        cook_minutes, cover_remote_url, cover_alt, is_active, created_at,
        updated_at, imported_at, deactivated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)
    `).run(
      recipeId, recipe.sourceKey, recipe.contentVersion, recipe.contentHash,
      recipe.schemaVersion, recipe.title, JSON.stringify(recipe.aliases), recipe.summary,
      recipe.tier, recipe.difficulty, recipe.servings, recipe.prepMinutes,
      recipe.cookMinutes, recipe.cover.remoteUrl ?? null, recipe.cover.alt,
      timestamp, timestamp, timestamp,
    );
  } else if (existing.content_hash !== recipe.contentHash) {
    db.prepare(`
      UPDATE recipes SET
        content_version = ?, content_hash = ?, schema_version = ?, title = ?,
        aliases_json = ?, summary = ?, tier = ?, difficulty = ?, servings = ?,
        prep_minutes = ?, cook_minutes = ?, cover_remote_url = ?, cover_alt = ?,
        is_active = 1, updated_at = ?, imported_at = ?, deactivated_at = NULL
      WHERE id = ?
    `).run(
      recipe.contentVersion, recipe.contentHash, recipe.schemaVersion, recipe.title,
      JSON.stringify(recipe.aliases), recipe.summary, recipe.tier, recipe.difficulty,
      recipe.servings, recipe.prepMinutes, recipe.cookMinutes,
      recipe.cover.remoteUrl ?? null, recipe.cover.alt, timestamp, timestamp, recipeId,
    );
  } else {
    db.prepare(`
      UPDATE recipes SET is_active = 1, imported_at = ?, deactivated_at = NULL
      WHERE id = ?
    `).run(timestamp, recipeId);
  }

  if (existing === undefined || existing.content_hash !== recipe.contentHash) {
    replaceChildren(db, recipe, recipeId, timestamp);
  }
  return { recipeId, disposition };
};

const rebuildAliases = (db: Database.Database, timestamp: string): void => {
  db.prepare('DELETE FROM ingredient_aliases').run();
  const rows = db.prepare(`
    SELECT
      MIN(s.alias_id) AS alias_id,
      s.ingredient_id,
      MIN(s.alias) AS alias,
      s.normalized_alias
    FROM recipe_ingredient_alias_sources s
    JOIN recipes r ON r.id = s.recipe_id AND r.is_active = 1
    GROUP BY s.ingredient_id, s.normalized_alias
    ORDER BY s.ingredient_id, s.normalized_alias
  `).all() as Array<{
    alias_id: string;
    ingredient_id: string;
    alias: string;
    normalized_alias: string;
  }>;
  const insert = db.prepare(`
    INSERT INTO ingredient_aliases (
      id, ingredient_id, alias, normalized_alias, position
    ) VALUES (?, ?, ?, ?, ?)
  `);
  let ingredientId = '';
  let position = 0;
  for (const row of rows) {
    if (row.ingredient_id !== ingredientId) {
      ingredientId = row.ingredient_id;
      position = 0;
    }
    insert.run(row.alias_id, row.ingredient_id, row.alias, row.normalized_alias, position);
    position += 1;
  }
  db.prepare(`
    UPDATE ingredients SET
      is_active = CASE WHEN EXISTS (
        SELECT 1 FROM recipe_ingredients ri
        JOIN recipes r ON r.id = ri.recipe_id AND r.is_active = 1
        WHERE ri.ingredient_id = ingredients.id
      ) THEN 1 ELSE 0 END,
      updated_at = ?
  `).run(timestamp);
};

const replaceSearchDocument = (
  db: Database.Database,
  recipe: NormalizedRecipe,
  recipeId: string,
  catalogVersion: number,
): void => {
  db.prepare('DELETE FROM recipe_search WHERE recipe_id = ?').run(recipeId);
  db.prepare(`
    INSERT INTO recipe_search (
      recipe_id, title_normalized, aliases_normalized, title_terms,
      ingredient_terms, alias_terms, summary_terms, tag_terms, tier,
      difficulty, total_minutes, catalog_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recipeId,
    recipe.search.titleNormalized,
    recipe.search.aliasesNormalized,
    recipe.search.titleTerms,
    recipe.search.ingredientTerms,
    recipe.search.aliasTerms,
    recipe.search.summaryTerms,
    recipe.search.tagTerms,
    recipe.tier,
    recipe.difficulty,
    recipe.prepMinutes + recipe.cookMinutes,
    catalogVersion,
  );
};

/** Runs validation/staging first, then performs one atomic business cutover. */
export const importRecipeCatalog = async (
  options: ImportRecipeCatalogOptions,
): Promise<ImportReport> => {
  const { db, inputPath, mode } = options;
  const now = options.now ?? (() => new Date());
  const report = createImportReport(mode, now());
  const normalizedRecipes: NormalizedRecipe[] = [];
  const seenSourceKeys = new Map<string, number>();
  createStageTable(db);
  const insertStage = db.prepare(`
    INSERT INTO temp.recipe_import_stage (
      line, source_key, content_hash, tier, canonical_json
    ) VALUES (?, ?, ?, ?, ?)
  `);

  try {
    for await (const record of readJsonl(inputPath, {
      ...(options.maximumLineBytes === undefined
        ? {}
        : { maximumLineBytes: options.maximumLineBytes }),
      blankLinePolicy: 'skip',
    })) {
      if ('error' in record) {
        report.rejected += 1;
        appendImportError(report, { line: record.line, ...record.error });
        continue;
      }

      const sourceKey = rawSourceKey(record.value);
      if (sourceKey !== undefined) {
        const normalizedSourceKey = normalizeLookupText(sourceKey);
        if (seenSourceKeys.has(normalizedSourceKey)) {
          throw new CatalogImportError('duplicate_normalized_source_key');
        }
        seenSourceKeys.set(normalizedSourceKey, record.line);
      }

      const parsed = safeCanonicalizeRecipe(record.value);
      if (!parsed.success) {
        report.rejected += 1;
        for (const issue of parsed.error.issues) {
          appendImportError(report, {
            line: record.line,
            ...(sourceKey === undefined ? {} : { sourceKey }),
            path: issuePath(issue.path),
            code: `validation_${issue.code}`,
          });
        }
        continue;
      }

      try {
        const normalized = normalizeRecipe(parsed.data);
        if (seenSourceKeys.get(normalized.recipe.sourceKey) !== record.line) {
          throw new CatalogImportError('duplicate_normalized_source_key');
        }
        insertStage.run(
          record.line,
          normalized.recipe.sourceKey,
          normalized.recipe.contentHash,
          normalized.recipe.tier,
          normalized.canonicalJson,
        );
        normalizedRecipes.push(normalized.recipe);
        report.accepted += 1;
        report.tierCounts[normalized.recipe.tier] += 1;
      } catch (error) {
        if (error instanceof CatalogImportError) {
          throw error;
        }
        report.rejected += 1;
        appendImportError(report, {
          line: record.line,
          ...(sourceKey === undefined ? {} : { sourceKey }),
          path: error instanceof RecipeNormalizationError ? error.path : '$',
          code: error instanceof RecipeNormalizationError ? error.code : 'normalization_failed',
        });
      }
    }

    if (mode === 'replace' && report.accepted === 0) {
      throw new CatalogImportError('empty_replace_catalog');
    }
    if (report.accepted === 0) {
      return finishImportReport(report, now());
    }
    validateCatalogAliasOwnership(db, mode, normalizedRecipes);
    options.hooks?.onEvent?.({ event: 'before-cutover', accepted: report.accepted });

    const stagedRows = db.prepare(`
      SELECT line, source_key, canonical_json
      FROM temp.recipe_import_stage ORDER BY line
    `).all() as StageRow[];
    let transactionStarted = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const currentVersion = db.prepare(`
        SELECT version FROM app_data_versions WHERE scope = 'recipe_catalog'
      `).get() as { version: number } | undefined;
      if (currentVersion === undefined) {
        throw new CatalogImportError('missing_recipe_catalog_version');
      }
      const catalogVersion = currentVersion.version + 1;
      const timestamp = now().toISOString();

      if (mode === 'replace') {
        const result = db.prepare(`
          UPDATE recipes SET
            is_active = 0,
            deactivated_at = ?,
            updated_at = ?
          WHERE is_active = 1
            AND source_key NOT IN (SELECT source_key FROM temp.recipe_import_stage)
        `).run(timestamp, timestamp);
        report.deactivated = result.changes;
      }

      for (const [index, row] of stagedRows.entries()) {
        const recipe = JSON.parse(row.canonical_json) as NormalizedRecipe;
        const result = writeRecipe(db, recipe, timestamp);
        if (result.disposition === 'inserted') {
          report.inserted += 1;
        } else if (result.disposition === 'unchanged') {
          report.unchanged += 1;
        } else {
          report.updated += 1;
        }
        replaceSearchDocument(db, recipe, result.recipeId, catalogVersion);
        options.hooks?.onEvent?.({
          event: 'after-recipe',
          index,
          sourceKey: row.source_key,
          disposition: result.disposition,
        });
      }

      db.prepare(`
        DELETE FROM recipe_search
        WHERE recipe_id IN (SELECT id FROM recipes WHERE is_active = 0)
      `).run();
      db.prepare('UPDATE recipe_search SET catalog_version = ?').run(catalogVersion);
      rebuildAliases(db, timestamp);
      options.hooks?.onEvent?.({ event: 'before-integrity-check' });
      db.exec(`
        INSERT INTO recipe_search_fts(recipe_search_fts, rank)
        VALUES('integrity-check', 1)
      `);
      db.prepare(`
        UPDATE app_data_versions SET version = ? WHERE scope = 'recipe_catalog'
      `).run(catalogVersion);
      options.hooks?.onEvent?.({ event: 'before-commit' });
      db.exec('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        db.exec('ROLLBACK');
      }
      throw error;
    }

    return finishImportReport(report, now());
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.recipe_import_stage');
  }
};
