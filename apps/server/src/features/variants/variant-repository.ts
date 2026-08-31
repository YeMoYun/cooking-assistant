import {
  AppError,
  recipeVariantDetailSchema,
  recipeVariantPageSchema,
  recipeVariantPreviewInputSchema,
  recipeVariantSchema,
  recipeVariantSummarySchema,
  type KitchenCategory,
  type RecipeVariant,
  type RecipeVariantDetail,
  type RecipeVariantPage,
  type RecipeVariantPreviewInput,
  type RecipeVariantSummary,
  type Unit,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../actions/canonical-json.js';
import type {
  VariantInventoryItem,
  VariantPreviewContext,
  VariantSourceIngredient,
  VariantSourceRecipe,
  VariantSourceStep,
} from './variant-types.js';

interface SourceRecipeRow {
  readonly id: string;
  readonly title: string;
  readonly servings: number;
  readonly content_version: string;
  readonly content_hash: string;
}

interface SourceIngredientRow {
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
  readonly is_optional: number;
}

interface SourceStepRow {
  readonly id: string;
  readonly step_number: number;
  readonly instruction: string;
  readonly completion_cue: string | null;
  readonly safety_requirement: string | null;
}

interface SourceStepIngredientRow {
  readonly recipe_step_id: string;
  readonly name: string;
}

interface InventoryContextRow {
  readonly id: string;
  readonly ingredient_id: string | null;
  readonly canonical_name: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly category: KitchenCategory;
}

interface VariantRow {
  readonly id: string;
  readonly source_recipe_id: string;
  readonly source_recipe_title: string;
  readonly name: string;
  readonly request_json: string;
  readonly result_json: string;
  readonly validator_version: string;
  readonly created_at: string;
}

interface VariantCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface InsertRecipeVariant {
  readonly id: string;
  readonly sourceRecipeId: string;
  readonly request: RecipeVariantPreviewInput;
  readonly result: RecipeVariant;
  readonly validatorVersion: string;
  readonly createdAt: string;
}

const sourceNotFound = (): AppError => new AppError(
  'recipe_not_found',
  '食谱不存在',
  404,
);

const variantNotFound = (): AppError => new AppError(
  'recipe_variant_not_found',
  '个人食谱版本不存在',
  404,
);

const encodeCursor = (cursor: VariantCursor): string => Buffer.from(
  JSON.stringify(cursor),
  'utf8',
).toString('base64url');

const decodeCursor = (value: string): VariantCursor => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).length !== 2
      || !('createdAt' in parsed)
      || typeof parsed.createdAt !== 'string'
      || Number.isNaN(Date.parse(parsed.createdAt))
      || !('id' in parsed)
      || typeof parsed.id !== 'string'
      || !/^[0-9a-f-]{36}$/iu.test(parsed.id)
    ) {
      throw new TypeError('Invalid variant cursor');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new AppError('validation_error', '个人版本游标无效', 400);
  }
};

const parseStoredRequest = (value: string): RecipeVariantPreviewInput => {
  try {
    return recipeVariantPreviewInputSchema.parse(JSON.parse(value));
  } catch {
    throw new Error('Stored recipe variant request is invalid');
  }
};

const parseStoredResult = (value: string): RecipeVariant => {
  try {
    return recipeVariantSchema.parse(JSON.parse(value));
  } catch {
    throw new Error('Stored recipe variant result is invalid');
  }
};

const summaryFromRow = (row: VariantRow): RecipeVariantSummary => {
  const result = parseStoredResult(row.result_json);
  return recipeVariantSummarySchema.parse({
    id: row.id,
    sourceRecipeId: row.source_recipe_id,
    sourceRecipeTitle: row.source_recipe_title,
    name: row.name,
    servings: result.servings,
    validatorVersion: row.validator_version,
    createdAt: row.created_at,
  });
};

const detailFromRow = (row: VariantRow): RecipeVariantDetail => (
  recipeVariantDetailSchema.parse({
    ...summaryFromRow(row),
    request: parseStoredRequest(row.request_json),
    result: parseStoredResult(row.result_json),
  })
);

const VARIANT_SELECT = `
  rv.id, rv.source_recipe_id, r.title AS source_recipe_title, rv.name,
  rv.request_json, rv.result_json, rv.validator_version, rv.created_at
`;

export class VariantRepository {
  constructor(private readonly db: Database.Database) {}

  loadPreviewContext(
    recipeId: string,
    inventoryItemIds: readonly string[],
  ): VariantPreviewContext {
    const read = this.db.transaction(() => {
      const sourceRecipe = this.readActiveSourceRecipe(recipeId);
      const inventoryItems = this.readSelectedInventory(inventoryItemIds);
      const scopes = inventoryItemIds.length === 0
        ? ['recipe_catalog', 'variants']
        : ['recipe_catalog', 'variants', 'inventory'];
      return {
        sourceRecipe,
        inventoryItems,
        dataVersions: this.readDataVersions(scopes),
      };
    });
    return read.deferred();
  }

  getActiveSourceRecipe(recipeId: string): VariantSourceRecipe {
    return this.readActiveSourceRecipe(recipeId);
  }

  assertSourceRecipeVersion(
    recipeId: string,
    contentVersion: string,
    contentHash: string,
  ): void {
    const current = this.db.prepare(`
      SELECT content_version, content_hash
      FROM recipes
      WHERE id = ? AND is_active = 1
    `).get(recipeId) as {
      readonly content_version: string;
      readonly content_hash: string;
    } | undefined;
    if (
      current === undefined
      || current.content_version !== contentVersion
      || current.content_hash !== contentHash
    ) {
      throw new AppError(
        'data_changed',
        '原食谱已变化，请重新生成修改预览',
        409,
      );
    }
  }

  /** Called inside PendingActionService's immediate transaction. */
  insert(input: InsertRecipeVariant): RecipeVariantDetail {
    this.db.prepare(`
      INSERT INTO recipe_variants(
        id, source_recipe_id, name, request_json, result_json,
        validator_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.sourceRecipeId,
      input.result.title,
      canonicalJson(input.request),
      canonicalJson(input.result),
      input.validatorVersion,
      input.createdAt,
    );
    const bumped = this.db.prepare(`
      UPDATE app_data_versions SET version = version + 1
      WHERE scope = 'variants'
    `).run();
    if (bumped.changes !== 1) {
      throw new Error('Missing variants data version');
    }
    return this.get(input.id);
  }

  list(cursorValue: string | undefined, limit: number): RecipeVariantPage {
    const cursor = cursorValue === undefined ? undefined : decodeCursor(cursorValue);
    const rows = this.db.prepare(`
      SELECT ${VARIANT_SELECT}
      FROM recipe_variants rv
      JOIN recipes r ON r.id = rv.source_recipe_id
      WHERE (
        @cursor_at IS NULL
        OR rv.created_at < @cursor_at
        OR (rv.created_at = @cursor_at AND rv.id < @cursor_id)
      )
      ORDER BY rv.created_at DESC, rv.id DESC
      LIMIT @row_limit
    `).all({
      cursor_at: cursor?.createdAt ?? null,
      cursor_id: cursor?.id ?? null,
      row_limit: limit + 1,
    }) as VariantRow[];
    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return recipeVariantPageSchema.parse({
      items: pageRows.map(summaryFromRow),
      nextCursor: hasNextPage && last !== undefined
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
    });
  }

  get(variantId: string): RecipeVariantDetail {
    const row = this.db.prepare(`
      SELECT ${VARIANT_SELECT}
      FROM recipe_variants rv
      JOIN recipes r ON r.id = rv.source_recipe_id
      WHERE rv.id = ?
    `).get(variantId) as VariantRow | undefined;
    if (row === undefined) {
      throw variantNotFound();
    }
    return detailFromRow(row);
  }

  private readActiveSourceRecipe(recipeId: string): VariantSourceRecipe {
    const row = this.db.prepare(`
      SELECT id, title, servings, content_version, content_hash
      FROM recipes
      WHERE id = ? AND is_active = 1
    `).get(recipeId) as SourceRecipeRow | undefined;
    if (row === undefined) {
      throw sourceNotFound();
    }

    const ingredients = this.db.prepare(`
      SELECT
        i.canonical_name AS name, ri.quantity, ri.unit, ri.is_optional
      FROM recipe_ingredients ri
      JOIN ingredients i ON i.id = ri.ingredient_id
      WHERE ri.recipe_id = ?
      ORDER BY ri.position ASC, ri.id ASC
    `).all(recipeId) as SourceIngredientRow[];
    const steps = this.db.prepare(`
      SELECT
        id, step_number, instruction, completion_cue, safety_requirement
      FROM recipe_steps
      WHERE recipe_id = ?
      ORDER BY step_number ASC, id ASC
    `).all(recipeId) as SourceStepRow[];
    const stepIngredients = this.db.prepare(`
      SELECT rsi.recipe_step_id, i.canonical_name AS name
      FROM recipe_step_ingredients rsi
      JOIN recipe_ingredients ri
        ON ri.id = rsi.recipe_ingredient_id
        AND ri.recipe_id = rsi.recipe_id
      JOIN ingredients i ON i.id = ri.ingredient_id
      JOIN recipe_steps rs
        ON rs.id = rsi.recipe_step_id
        AND rs.recipe_id = rsi.recipe_id
      WHERE rsi.recipe_id = ?
      ORDER BY rs.step_number ASC, rsi.position ASC, ri.id ASC
    `).all(recipeId) as SourceStepIngredientRow[];
    const namesByStep = new Map<string, string[]>();
    for (const item of stepIngredients) {
      const names = namesByStep.get(item.recipe_step_id) ?? [];
      names.push(item.name);
      namesByStep.set(item.recipe_step_id, names);
    }

    return {
      id: row.id,
      title: row.title,
      servings: row.servings,
      contentVersion: row.content_version,
      contentHash: row.content_hash,
      ingredients: ingredients.map((ingredient): VariantSourceIngredient => ({
        name: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        optional: ingredient.is_optional === 1,
      })),
      steps: steps.map((step): VariantSourceStep => ({
        number: step.step_number,
        instruction: step.instruction,
        ingredientNames: namesByStep.get(step.id) ?? [],
        completionCue: step.completion_cue,
        safetyRequirement: step.safety_requirement,
      })),
    };
  }

  private readSelectedInventory(
    itemIds: readonly string[],
  ): readonly VariantInventoryItem[] {
    if (itemIds.length === 0) {
      return [];
    }
    const placeholders = itemIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT id, ingredient_id, canonical_name, quantity, unit, category
      FROM inventory_items
      WHERE id IN (${placeholders})
    `).all(...itemIds) as InventoryContextRow[];
    if (rows.length !== itemIds.length) {
      throw new AppError(
        'inventory_context_changed',
        '所选库存食材已变化，请重新选择',
        409,
      );
    }
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return itemIds.map((itemId) => {
      const row = rowsById.get(itemId);
      if (row === undefined) {
        throw new Error('Selected inventory row disappeared');
      }
      return {
        id: row.id,
        ingredientId: row.ingredient_id,
        name: row.canonical_name,
        quantity: row.quantity,
        unit: row.unit,
        category: row.category,
      };
    });
  }

  private readDataVersions(scopes: readonly string[]): Record<string, number> {
    const placeholders = scopes.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT scope, version FROM app_data_versions
      WHERE scope IN (${placeholders})
    `).all(...scopes) as Array<{
      readonly scope: string;
      readonly version: number;
    }>;
    const versions = Object.fromEntries(rows.map((row) => [row.scope, row.version]));
    if (rows.length !== scopes.length) {
      throw new Error('Missing recipe variant data version');
    }
    return versions;
  }
}

