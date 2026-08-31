import { randomUUID } from 'node:crypto';
import {
  AppError,
  kitchenUnitSchema,
  pendingActionPreviewSchema,
  shoppingItemSchema,
  shoppingSnapshotSchema,
  toDisplayQuantity,
  unitFamily,
  type CreateShoppingItem,
  type GenerateShoppingPreview,
  type InventoryItem,
  type KitchenCategory,
  type PendingActionPreview,
  type ShoppingItem,
  type ShoppingSnapshot,
  type Unit,
  type UpdateShoppingItem,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { PendingActionService } from '../actions/pending-action-service.js';
import {
  InventoryRepository,
} from '../inventory/inventory-repository.js';
import { IngredientUnitConverter } from './unit-converter.js';

interface ShoppingRow {
  readonly id: string;
  readonly ingredient_id: string | null;
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly category: KitchenCategory;
  readonly requires_review: number;
  readonly is_checked: number;
  readonly sources_json: string;
  readonly source: 'manual' | 'generated';
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
}

interface IngredientRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly category: KitchenCategory;
}

interface RecipeRow {
  readonly id: string;
  readonly title: string;
  readonly servings: number;
}

interface RecipeIngredientRow {
  readonly ingredient_id: string;
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly category: KitchenCategory;
  readonly quantity: number;
  readonly unit: string;
}

interface InventoryCalculationRow {
  readonly ingredient_id: string | null;
  readonly normalized_name: string;
  readonly quantity: number;
  readonly unit: Unit;
}

interface WorkingLine {
  ingredientId: string | null;
  name: string;
  normalizedName: string;
  quantity: number;
  unit: Unit;
  category: KitchenCategory;
  requiresReview: boolean;
  sources: string[];
}

const generatedItemSchema = z.object({
  id: z.string().uuid(),
  ingredientId: z.string().min(1).max(100).nullable(),
  name: z.string().min(1).max(80),
  normalizedName: z.string().min(1).max(80),
  quantity: z.number().finite().positive(),
  unit: kitchenUnitSchema,
  category: z.enum([
    'produce',
    'meat_egg_dairy',
    'staple',
    'seasoning',
    'other',
  ]),
  requiresReview: z.boolean(),
  sources: z.array(z.string().min(1).max(100)).min(1).max(20),
}).strict();

const generatedPayloadSchema = z.object({
  items: z.array(generatedItemSchema).max(500),
}).strict();

type GeneratedPayload = z.infer<typeof generatedPayloadSchema>;

const sourceListSchema = z.array(z.string().min(1).max(100)).max(50);
const EPSILON = 1e-9;

const normalizeName = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}\s]+/gu, ' ')
  .trim();

const displayName = (value: string): string => value
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim();

const stableQuantity = (value: number): number => (
  Math.round(value * 1_000_000_000) / 1_000_000_000
);

const sameIngredient = (
  left: Pick<WorkingLine, 'ingredientId' | 'normalizedName'>,
  right: Pick<WorkingLine, 'ingredientId' | 'normalizedName'>,
): boolean => (
  left.ingredientId !== null && right.ingredientId !== null
    ? left.ingredientId === right.ingredientId
    : left.normalizedName === right.normalizedName
);

const parseSources = (value: string): string[] => {
  try {
    return sourceListSchema.parse(JSON.parse(value));
  } catch {
    throw new Error('Invalid shopping item sources');
  }
};

const mapShoppingItem = (row: ShoppingRow): ShoppingItem => (
  shoppingItemSchema.parse({
    id: row.id,
    ingredientId: row.ingredient_id,
    name: row.canonical_name,
    quantity: row.quantity,
    unit: row.unit,
    category: row.category,
    requiresReview: row.requires_review === 1,
    checked: row.is_checked === 1,
    sources: parseSources(row.sources_json),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  })
);

const shoppingNotFound = (): AppError => new AppError(
  'shopping_item_not_found',
  '购物条目不存在',
  404,
);

const shoppingChanged = (): AppError => new AppError(
  'item_changed',
  '购物条目已变化，请刷新后重试',
  409,
);

export interface ShoppingServiceOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

export class ShoppingService {
  readonly #converter: IngredientUnitConverter;
  readonly #inventory: InventoryRepository;
  readonly #pendingActions: PendingActionService;
  readonly #now: () => number;

  constructor(
    private readonly db: Database.Database,
    options: ShoppingServiceOptions = {},
  ) {
    this.#converter = new IngredientUnitConverter(db);
    this.#inventory = new InventoryRepository(db);
    this.#pendingActions = new PendingActionService(db, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.randomBytes === undefined
        ? {}
        : { randomBytes: options.randomBytes }),
    });
    this.#now = options.now ?? Date.now;
  }

  getSnapshot(): ShoppingSnapshot {
    const read = this.db.transaction(() => this.getSnapshotInCurrentTransaction());
    return read.deferred();
  }

  create(input: CreateShoppingItem): ShoppingItem {
    const now = this.nowIso();
    const mutate = this.db.transaction(() => {
      const resolved = this.resolveIngredient(
        input.ingredientId,
        input.name,
        input.category,
      );
      const stored = this.normalizeQuantity(input.quantity, input.unit);
      const existing = this.getRow(input.itemId);
      if (existing !== undefined) {
        const same = existing.ingredient_id === resolved.ingredientId
          && existing.canonical_name === resolved.name
          && existing.quantity === stored.quantity
          && existing.unit === stored.unit
          && existing.category === resolved.category
          && existing.source === 'manual';
        if (!same) {
          throw new AppError(
            'shopping_item_conflict',
            '购物条目标识已被其他内容使用',
            409,
          );
        }
        return mapShoppingItem(existing);
      }
      this.db.prepare(`
        INSERT INTO shopping_items(
          id, ingredient_id, canonical_name, normalized_name, quantity, unit,
          category, requires_review, is_checked, sources_json, source,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'manual', ?, ?, 1)
      `).run(
        input.itemId,
        resolved.ingredientId,
        resolved.name,
        resolved.normalizedName,
        stored.quantity,
        stored.unit,
        resolved.category,
        unitFamily(stored.unit) === 'qualitative' ? 1 : 0,
        now,
        now,
      );
      this.bumpVersion('shopping');
      const created = this.getRow(input.itemId);
      if (created === undefined) {
        throw new Error('Created shopping item could not be read back');
      }
      return mapShoppingItem(created);
    });
    return mutate.immediate();
  }

  update(itemId: string, input: UpdateShoppingItem): ShoppingItem {
    const now = this.nowIso();
    const mutate = this.db.transaction(() => {
      const current = this.getRow(itemId);
      if (current === undefined) {
        throw shoppingNotFound();
      }
      if (current.version !== input.expectedVersion) {
        throw shoppingChanged();
      }
      const resolved = this.resolveIngredient(
        current.ingredient_id,
        input.name ?? current.canonical_name,
        input.category ?? current.category,
      );
      const stored = this.updatedQuantity(
        current.quantity,
        current.unit,
        input.quantity,
        input.unit,
      );
      const checked = input.checked ?? (current.is_checked === 1);
      const requiresReview = current.requires_review === 1
        || unitFamily(stored.unit) === 'qualitative';
      const unchanged = current.canonical_name === resolved.name
        && current.quantity === stored.quantity
        && current.unit === stored.unit
        && current.category === resolved.category
        && current.is_checked === (checked ? 1 : 0)
        && current.requires_review === (requiresReview ? 1 : 0);
      if (unchanged) {
        return mapShoppingItem(current);
      }
      const result = this.db.prepare(`
        UPDATE shopping_items SET
          ingredient_id = ?, canonical_name = ?, normalized_name = ?,
          quantity = ?, unit = ?, category = ?, requires_review = ?,
          is_checked = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(
        resolved.ingredientId,
        resolved.name,
        resolved.normalizedName,
        stored.quantity,
        stored.unit,
        resolved.category,
        requiresReview ? 1 : 0,
        checked ? 1 : 0,
        now,
        itemId,
        input.expectedVersion,
      );
      if (result.changes !== 1) {
        throw shoppingChanged();
      }
      this.bumpVersion('shopping');
      const updated = this.getRow(itemId);
      if (updated === undefined) {
        throw shoppingNotFound();
      }
      return mapShoppingItem(updated);
    });
    return mutate.immediate();
  }

  delete(itemId: string, expectedVersion: number): void {
    const mutate = this.db.transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM shopping_items WHERE id = ? AND version = ?
      `).run(itemId, expectedVersion);
      if (result.changes !== 1) {
        if (this.getRow(itemId) === undefined) {
          throw shoppingNotFound();
        }
        throw shoppingChanged();
      }
      this.bumpVersion('shopping');
    });
    mutate.immediate();
  }

  generatePreview(
    request: GenerateShoppingPreview,
    sessionId: string,
  ): PendingActionPreview {
    const calculate = this.db.transaction(() => {
      const versions = this.getVersions(['inventory', 'shopping']);
      const lines = this.loadRecipeLines(request);
      const merged = this.mergeLines(lines);
      this.subtractInventory(merged);
      const items: GeneratedPayload['items'] = merged
        .filter((line) => line.quantity > EPSILON)
        .map((line) => ({
          id: randomUUID(),
          ingredientId: line.ingredientId,
          name: line.name,
          normalizedName: line.normalizedName,
          quantity: stableQuantity(line.quantity),
          unit: line.unit,
          category: line.category,
          requiresReview: line.requiresReview,
          sources: [...line.sources].sort(),
        }));
      return {
        versions,
        payload: generatedPayloadSchema.parse({ items }),
      };
    });
    const calculated = calculate.deferred();
    const issued = this.#pendingActions.issue({
      kind: 'shopping_items',
      toolName: 'generate_shopping_items',
      sessionId,
      arguments: request,
      payload: calculated.payload,
      expectedDataVersions: calculated.versions,
      primaryVersionScope: 'shopping',
    });

    return pendingActionPreviewSchema.parse({
      pendingActionId: issued.pendingActionId,
      title: '生成购物清单',
      expiresAt: issued.expiresAt,
      kind: 'shopping_items',
      preview: {
        items: calculated.payload.items.map((item) => {
          const display = toDisplayQuantity(
            item.quantity,
            item.unit,
            item.category,
          );
          return {
            name: item.name,
            quantity: display.quantity,
            unit: display.unit,
            category: item.category,
            requiresReview: item.requiresReview,
            sources: item.sources,
          };
        }),
      },
    });
  }

  confirmGenerated(pendingActionId: string, sessionId: string): ShoppingSnapshot {
    return this.#pendingActions.confirm({
      pendingActionId,
      sessionId,
      toolName: 'generate_shopping_items',
      parsePayload: (value) => generatedPayloadSchema.parse(value),
      execute: (payload) => {
        this.applyGeneratedInCurrentTransaction(payload);
        return this.getSnapshotInCurrentTransaction();
      },
    });
  }

  addCheckedItemToInventory(
    shoppingItemId: string,
    inventoryItemId: string,
  ): InventoryItem {
    const now = this.nowIso();
    const mutate = this.db.transaction(() => {
      const shopping = this.getRow(shoppingItemId);
      if (shopping === undefined) {
        throw shoppingNotFound();
      }
      if (shopping.is_checked !== 1) {
        throw new AppError(
          'shopping_item_not_checked',
          '只有已购条目才能加入冰箱库存',
          409,
        );
      }
      return this.#inventory.addFromShoppingInCurrentTransaction({
        id: inventoryItemId,
        ingredientId: shopping.ingredient_id,
        name: shopping.canonical_name,
        normalizedName: shopping.normalized_name,
        quantity: shopping.quantity,
        unit: shopping.unit,
        category: shopping.category,
      }, now);
    });
    return mutate.immediate();
  }

  private loadRecipeLines(request: GenerateShoppingPreview): WorkingLine[] {
    const lines: WorkingLine[] = [];
    for (const selection of request.recipes) {
      const recipe = this.db.prepare(`
        SELECT id, title, servings
        FROM recipes WHERE id = ? AND is_active = 1
      `).get(selection.recipeId) as RecipeRow | undefined;
      if (recipe === undefined) {
        throw new AppError('recipe_not_found', '食谱不存在', 404);
      }
      const ingredients = this.db.prepare(`
        SELECT
          ri.ingredient_id, i.canonical_name, i.normalized_name, i.category,
          ri.quantity, ri.unit
        FROM recipe_ingredients ri
        JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = ? AND ri.is_optional = 0
        ORDER BY ri.position ASC, ri.id ASC
      `).all(recipe.id) as RecipeIngredientRow[];
      const scale = selection.servings / recipe.servings;
      for (const ingredient of ingredients) {
        const stored = this.normalizeQuantity(
          ingredient.quantity * scale,
          ingredient.unit,
        );
        lines.push({
          ingredientId: ingredient.ingredient_id,
          name: ingredient.canonical_name,
          normalizedName: ingredient.normalized_name,
          quantity: stored.quantity,
          unit: stored.unit,
          category: ingredient.category,
          requiresReview: unitFamily(stored.unit) === 'qualitative',
          sources: [recipe.title],
        });
      }
    }
    return lines;
  }

  private mergeLines(input: readonly WorkingLine[]): WorkingLine[] {
    const merged: WorkingLine[] = [];
    for (const original of input) {
      const line: WorkingLine = { ...original, sources: [...original.sources] };
      const sameIngredientLines = merged.filter((candidate) => (
        sameIngredient(candidate, line)
      ));
      const compatible = sameIngredientLines.find((candidate) => (
        this.#converter.convert(
          line.quantity,
          line.unit,
          candidate.unit,
          line.ingredientId ?? candidate.ingredientId,
        ) !== undefined
      ));
      if (compatible === undefined) {
        if (sameIngredientLines.length > 0) {
          line.requiresReview = true;
          sameIngredientLines.forEach((candidate) => {
            candidate.requiresReview = true;
          });
        }
        merged.push(line);
        continue;
      }
      const converted = this.#converter.convert(
        line.quantity,
        line.unit,
        compatible.unit,
        line.ingredientId ?? compatible.ingredientId,
      );
      if (converted === undefined) {
        throw new Error('Unit compatibility changed during merge');
      }
      compatible.quantity = stableQuantity(compatible.quantity + converted);
      compatible.requiresReview ||= line.requiresReview;
      compatible.sources = [...new Set([
        ...compatible.sources,
        ...line.sources,
      ])];
    }
    return merged;
  }

  private subtractInventory(lines: WorkingLine[]): void {
    const inventory = this.db.prepare(`
      SELECT ingredient_id, normalized_name, quantity, unit
      FROM inventory_items
      ORDER BY updated_at ASC, id ASC
    `).all() as InventoryCalculationRow[];
    for (const stored of inventory) {
      if (unitFamily(stored.unit) === 'qualitative') {
        continue;
      }
      let remaining = stored.quantity;
      const candidates = lines
        .filter((line) => sameIngredient(line, {
          ingredientId: stored.ingredient_id,
          normalizedName: stored.normalized_name,
        }))
        .sort((left, right) => (
          Number(right.unit === stored.unit) - Number(left.unit === stored.unit)
        ));
      for (const line of candidates) {
        if (remaining <= EPSILON || line.quantity <= EPSILON) {
          continue;
        }
        if (unitFamily(line.unit) === 'qualitative') {
          line.requiresReview = true;
          continue;
        }
        const availableForLine = this.#converter.convert(
          remaining,
          stored.unit,
          line.unit,
          line.ingredientId ?? stored.ingredient_id,
        );
        if (availableForLine === undefined) {
          line.requiresReview = true;
          continue;
        }
        const deductedFromLine = Math.min(line.quantity, availableForLine);
        const usedInventory = this.#converter.convert(
          deductedFromLine,
          line.unit,
          stored.unit,
          line.ingredientId ?? stored.ingredient_id,
        );
        if (usedInventory === undefined) {
          throw new Error('Inventory conversion was not reversible');
        }
        line.quantity = stableQuantity(Math.max(0, line.quantity - deductedFromLine));
        remaining = stableQuantity(Math.max(0, remaining - usedInventory));
      }
    }
  }

  private applyGeneratedInCurrentTransaction(payload: GeneratedPayload): void {
    if (payload.items.length === 0) {
      return;
    }
    const now = this.nowIso();
    for (const item of payload.items) {
      const candidates = this.db.prepare(`
        SELECT
          id, ingredient_id, canonical_name, normalized_name, quantity, unit,
          category, requires_review, is_checked, sources_json, source,
          created_at, updated_at, version
        FROM shopping_items
        WHERE is_checked = 0
          AND (
            (ingredient_id IS NOT NULL AND ingredient_id = @ingredient_id)
            OR normalized_name = @normalized_name
          )
        ORDER BY created_at ASC, id ASC
      `).all({
        ingredient_id: item.ingredientId,
        normalized_name: item.normalizedName,
      }) as ShoppingRow[];
      const compatible = candidates.find((candidate) => (
        this.#converter.convert(
          item.quantity,
          item.unit,
          candidate.unit,
          item.ingredientId ?? candidate.ingredient_id,
        ) !== undefined
      ));
      if (compatible !== undefined) {
        const converted = this.#converter.convert(
          item.quantity,
          item.unit,
          compatible.unit,
          item.ingredientId ?? compatible.ingredient_id,
        );
        if (converted === undefined) {
          throw new Error('Unit compatibility changed while saving shopping item');
        }
        const sources = [...new Set([
          ...parseSources(compatible.sources_json),
          ...item.sources,
        ])].sort();
        this.db.prepare(`
          UPDATE shopping_items SET
            quantity = ?, requires_review = ?, sources_json = ?,
            updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(
          stableQuantity(compatible.quantity + converted),
          compatible.requires_review === 1 || item.requiresReview ? 1 : 0,
          JSON.stringify(sources),
          now,
          compatible.id,
        );
        continue;
      }

      const hasIncompatible = candidates.length > 0;
      if (hasIncompatible) {
        this.db.prepare(`
          UPDATE shopping_items SET
            requires_review = 1, updated_at = ?, version = version + 1
          WHERE is_checked = 0
            AND (
              (ingredient_id IS NOT NULL AND ingredient_id = ?)
              OR normalized_name = ?
            )
        `).run(now, item.ingredientId, item.normalizedName);
      }
      this.db.prepare(`
        INSERT INTO shopping_items(
          id, ingredient_id, canonical_name, normalized_name, quantity, unit,
          category, requires_review, is_checked, sources_json, source,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'generated', ?, ?, 1)
      `).run(
        item.id,
        item.ingredientId,
        item.name,
        item.normalizedName,
        item.quantity,
        item.unit,
        item.category,
        item.requiresReview || hasIncompatible ? 1 : 0,
        JSON.stringify(item.sources),
        now,
        now,
      );
    }
    this.bumpVersion('shopping');
  }

  private getSnapshotInCurrentTransaction(): ShoppingSnapshot {
    const version = this.getVersion('shopping');
    const rows = this.db.prepare(`
      SELECT
        id, ingredient_id, canonical_name, normalized_name, quantity, unit,
        category, requires_review, is_checked, sources_json, source,
        created_at, updated_at, version
      FROM shopping_items
      ORDER BY is_checked ASC, category ASC, normalized_name ASC, unit ASC, id ASC
    `).all() as ShoppingRow[];
    return shoppingSnapshotSchema.parse({
      version,
      items: rows.map(mapShoppingItem),
    });
  }

  private updatedQuantity(
    currentQuantity: number,
    currentUnit: Unit,
    requestedQuantity: number | undefined,
    requestedUnit: string | undefined,
  ): { readonly quantity: number; readonly unit: Unit } {
    if (requestedQuantity !== undefined) {
      return this.normalizeQuantity(
        requestedQuantity,
        requestedUnit ?? currentUnit,
      );
    }
    if (requestedUnit === undefined) {
      return { quantity: currentQuantity, unit: currentUnit };
    }
    const normalizedUnit = this.normalizeQuantity(1, requestedUnit).unit;
    const converted = this.#converter.convert(
      currentQuantity,
      currentUnit,
      normalizedUnit,
      null,
    );
    return converted === undefined
      ? { quantity: currentQuantity, unit: normalizedUnit }
      : this.normalizeQuantity(converted, normalizedUnit);
  }

  private normalizeQuantity(
    quantity: number,
    unit: string,
  ): { readonly quantity: number; readonly unit: Unit } {
    try {
      const stored = this.#converter.normalize(quantity, unit);
      return { quantity: stableQuantity(stored.quantity), unit: stored.unit };
    } catch {
      throw new AppError('unsupported_unit', '单位不受支持', 400);
    }
  }

  private resolveIngredient(
    ingredientId: string | null,
    requestedName: string,
    requestedCategory: KitchenCategory,
  ): {
    readonly ingredientId: string | null;
    readonly name: string;
    readonly normalizedName: string;
    readonly category: KitchenCategory;
  } {
    let ingredient: IngredientRow | undefined;
    if (ingredientId !== null) {
      ingredient = this.db.prepare(`
        SELECT id, canonical_name, normalized_name, category
        FROM ingredients WHERE id = ? AND is_active = 1
      `).get(ingredientId) as IngredientRow | undefined;
      if (ingredient === undefined) {
        throw new AppError('ingredient_not_found', '标准食材不存在', 400);
      }
    } else {
      const normalized = normalizeName(requestedName);
      ingredient = this.db.prepare(`
        SELECT i.id, i.canonical_name, i.normalized_name, i.category
        FROM ingredients i
        WHERE i.is_active = 1 AND i.normalized_name = ?
        UNION ALL
        SELECT i.id, i.canonical_name, i.normalized_name, i.category
        FROM ingredient_aliases a
        JOIN ingredients i ON i.id = a.ingredient_id
        WHERE i.is_active = 1 AND a.normalized_alias = ?
        LIMIT 1
      `).get(normalized, normalized) as IngredientRow | undefined;
    }
    if (ingredient !== undefined) {
      return {
        ingredientId: ingredient.id,
        name: ingredient.canonical_name,
        normalizedName: ingredient.normalized_name,
        category: ingredient.category,
      };
    }
    const name = displayName(requestedName);
    const normalizedName = normalizeName(name);
    if (normalizedName.length === 0) {
      throw new AppError('validation_error', '食材名称无效', 400);
    }
    return {
      ingredientId: null,
      name,
      normalizedName,
      category: requestedCategory,
    };
  }

  private getRow(itemId: string): ShoppingRow | undefined {
    return this.db.prepare(`
      SELECT
        id, ingredient_id, canonical_name, normalized_name, quantity, unit,
        category, requires_review, is_checked, sources_json, source,
        created_at, updated_at, version
      FROM shopping_items WHERE id = ?
    `).get(itemId) as ShoppingRow | undefined;
  }

  private getVersions(scopes: readonly string[]): Record<string, number> {
    return Object.fromEntries(scopes.map((scope) => [
      scope,
      this.getVersion(scope),
    ]));
  }

  private getVersion(scope: string): number {
    const row = this.db.prepare(`
      SELECT version FROM app_data_versions WHERE scope = ?
    `).get(scope) as { readonly version: number } | undefined;
    if (row === undefined) {
      throw new Error(`Missing data version: ${scope}`);
    }
    return row.version;
  }

  private bumpVersion(scope: string): void {
    const result = this.db.prepare(`
      UPDATE app_data_versions SET version = version + 1 WHERE scope = ?
    `).run(scope);
    if (result.changes !== 1) {
      throw new Error(`Missing data version: ${scope}`);
    }
  }

  private nowIso(): string {
    return new Date(this.#now()).toISOString();
  }
}
