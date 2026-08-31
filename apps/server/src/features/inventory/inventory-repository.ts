import {
  AppError,
  inventoryItemSchema,
  inventorySnapshotSchema,
  recipeMatchPageSchema,
  canConvertUnit,
  requireUnit,
  toBaseQuantity,
  type CreateInventoryItem,
  type InventoryItem,
  type InventorySnapshot,
  type KitchenCategory,
  type RecipeMatchPage,
  type Unit,
  type UpdateInventoryItem,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';

interface InventoryRow {
  readonly id: string;
  readonly ingredient_id: string | null;
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly category: KitchenCategory;
  readonly source: 'manual' | 'vision' | 'shopping';
  readonly confirmed_at: string;
  readonly updated_at: string;
  readonly version: number;
}

interface IngredientRow {
  readonly id: string;
  readonly canonical_name: string;
  readonly normalized_name: string;
  readonly category: KitchenCategory;
}

interface MatchRow {
  readonly recipe_id: string;
  readonly title: string;
  readonly covered_count: number;
  readonly total_count: number;
  readonly coverage_key: number;
}

interface RecipeMatchCursor {
  readonly mode: 'all' | 'best';
  readonly coverageKey: number;
  readonly recipeId: string;
  readonly inventoryVersion: number;
  readonly catalogVersion: number;
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

const inventoryNotFound = (): AppError => new AppError(
  'inventory_item_not_found',
  '库存条目不存在',
  404,
);

const inventoryChanged = (): AppError => new AppError(
  'item_changed',
  '库存条目已变化，请刷新后重试',
  409,
);

const mapInventoryItem = (row: InventoryRow): InventoryItem => (
  inventoryItemSchema.parse({
    id: row.id,
    ingredientId: row.ingredient_id,
    name: row.canonical_name,
    quantity: row.quantity,
    unit: row.unit,
    category: row.category,
    source: row.source,
    confirmedAt: row.confirmed_at,
    updatedAt: row.updated_at,
    version: row.version,
  })
);

const encodeMatchCursor = (cursor: RecipeMatchCursor): string => Buffer.from(
  JSON.stringify(cursor),
  'utf8',
).toString('base64url');

const decodeMatchCursor = (value: string): RecipeMatchCursor => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).length !== 5
      || !('mode' in parsed)
      || (parsed.mode !== 'all' && parsed.mode !== 'best')
      || !('coverageKey' in parsed)
      || !Number.isSafeInteger(parsed.coverageKey)
      || (parsed.coverageKey as number) < 0
      || (parsed.coverageKey as number) > 1_000_000
      || !('recipeId' in parsed)
      || typeof parsed.recipeId !== 'string'
      || parsed.recipeId.length < 1
      || parsed.recipeId.length > 100
      || !('inventoryVersion' in parsed)
      || !Number.isSafeInteger(parsed.inventoryVersion)
      || (parsed.inventoryVersion as number) < 0
      || !('catalogVersion' in parsed)
      || !Number.isSafeInteger(parsed.catalogVersion)
      || (parsed.catalogVersion as number) < 0
    ) {
      throw new TypeError('Invalid cursor');
    }
    return parsed as unknown as RecipeMatchCursor;
  } catch {
    throw new AppError('validation_error', '食谱匹配游标无效', 400);
  }
};

export interface RecipeMatchRequest {
  readonly mode: 'all' | 'best';
  readonly cursor?: string;
  readonly limit: number;
}

export interface InventoryInsertFromShopping {
  readonly id: string;
  readonly ingredientId: string | null;
  readonly name: string;
  readonly normalizedName: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly category: KitchenCategory;
}

export class InventoryRepository {
  constructor(private readonly db: Database.Database) {}

  getSnapshot(): InventorySnapshot {
    const read = this.db.transaction(() => {
      const version = this.getDataVersion('inventory');
      const rows = this.db.prepare(`
        SELECT
          id, ingredient_id, canonical_name, normalized_name, quantity, unit,
          category, source, confirmed_at, updated_at, version
        FROM inventory_items
        ORDER BY category ASC, normalized_name ASC, unit ASC, id ASC
      `).all() as InventoryRow[];
      return inventorySnapshotSchema.parse({
        version,
        items: rows.map(mapInventoryItem),
      });
    });
    return read.deferred();
  }

  create(input: CreateInventoryItem, now: string): InventoryItem {
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
          && existing.source === input.source;
        if (!same) {
          throw new AppError(
            'inventory_item_conflict',
            '库存条目标识已被其他内容使用',
            409,
          );
        }
        return mapInventoryItem(existing);
      }

      this.db.prepare(`
        INSERT INTO inventory_items(
          id, ingredient_id, canonical_name, normalized_name, quantity, unit,
          category, source, confirmed_at, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        input.itemId,
        resolved.ingredientId,
        resolved.name,
        resolved.normalizedName,
        stored.quantity,
        stored.unit,
        resolved.category,
        input.source,
        now,
        now,
        now,
      );
      this.bumpDataVersion('inventory');
      const created = this.getRow(input.itemId);
      if (created === undefined) {
        throw new Error('Created inventory item could not be read back');
      }
      return mapInventoryItem(created);
    });
    return mutate.immediate();
  }

  update(
    itemId: string,
    input: UpdateInventoryItem,
    now: string,
  ): InventoryItem {
    const mutate = this.db.transaction(() => {
      const current = this.getRow(itemId);
      if (current === undefined) {
        throw inventoryNotFound();
      }
      if (current.version !== input.expectedVersion) {
        throw inventoryChanged();
      }
      const resolved = this.resolveIngredient(
        input.ingredientId === undefined
          ? current.ingredient_id
          : input.ingredientId,
        input.name ?? current.canonical_name,
        input.category ?? current.category,
      );
      const stored = this.updatedQuantity(
        current.quantity,
        current.unit,
        input.quantity,
        input.unit,
      );
      const unchanged = current.ingredient_id === resolved.ingredientId
        && current.canonical_name === resolved.name
        && current.quantity === stored.quantity
        && current.unit === stored.unit
        && current.category === resolved.category;
      if (unchanged) {
        return mapInventoryItem(current);
      }

      const result = this.db.prepare(`
        UPDATE inventory_items SET
          ingredient_id = ?, canonical_name = ?, normalized_name = ?,
          quantity = ?, unit = ?, category = ?, updated_at = ?,
          version = version + 1
        WHERE id = ? AND version = ?
      `).run(
        resolved.ingredientId,
        resolved.name,
        resolved.normalizedName,
        stored.quantity,
        stored.unit,
        resolved.category,
        now,
        itemId,
        input.expectedVersion,
      );
      if (result.changes !== 1) {
        throw inventoryChanged();
      }
      this.bumpDataVersion('inventory');
      const updated = this.getRow(itemId);
      if (updated === undefined) {
        throw inventoryNotFound();
      }
      return mapInventoryItem(updated);
    });
    return mutate.immediate();
  }

  delete(itemId: string, expectedVersion: number): void {
    const mutate = this.db.transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM inventory_items WHERE id = ? AND version = ?
      `).run(itemId, expectedVersion);
      if (result.changes !== 1) {
        const exists = this.getRow(itemId);
        if (exists === undefined) {
          throw inventoryNotFound();
        }
        throw inventoryChanged();
      }
      this.bumpDataVersion('inventory');
    });
    mutate.immediate();
  }

  addFromShoppingInCurrentTransaction(
    input: InventoryInsertFromShopping,
    now: string,
  ): InventoryItem {
    const existing = this.getRow(input.id);
    if (existing !== undefined) {
      const same = existing.ingredient_id === input.ingredientId
        && existing.normalized_name === input.normalizedName
        && existing.quantity === input.quantity
        && existing.unit === input.unit
        && existing.category === input.category
        && existing.source === 'shopping';
      if (!same) {
        throw new AppError(
          'inventory_item_conflict',
          '库存条目标识已被其他内容使用',
          409,
        );
      }
      return mapInventoryItem(existing);
    }
    this.db.prepare(`
      INSERT INTO inventory_items(
        id, ingredient_id, canonical_name, normalized_name, quantity, unit,
        category, source, confirmed_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'shopping', ?, ?, ?, 1)
    `).run(
      input.id,
      input.ingredientId,
      input.name,
      input.normalizedName,
      input.quantity,
      input.unit,
      input.category,
      now,
      now,
      now,
    );
    this.bumpDataVersion('inventory');
    const created = this.getRow(input.id);
    if (created === undefined) {
      throw new Error('Inventory item could not be read back');
    }
    return mapInventoryItem(created);
  }

  findRecipeMatches(request: RecipeMatchRequest): RecipeMatchPage {
    const cursor = request.cursor === undefined
      ? undefined
      : decodeMatchCursor(request.cursor);
    const read = this.db.transaction(() => {
      const inventoryVersion = this.getDataVersion('inventory');
      const catalogVersion = this.getDataVersion('recipe_catalog');
      if (
        cursor !== undefined
        && (
          cursor.mode !== request.mode
          || cursor.inventoryVersion !== inventoryVersion
          || cursor.catalogVersion !== catalogVersion
        )
      ) {
        throw new AppError(
          'data_changed',
          '库存或食谱目录已变化，请重新加载',
          409,
        );
      }

      const rows = this.db.prepare(`
        WITH coverage AS (
          SELECT
            r.id AS recipe_id,
            r.title,
            COUNT(ri.id) AS total_count,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM inventory_items inv
              WHERE inv.ingredient_id = ri.ingredient_id
                OR (
                  inv.ingredient_id IS NULL
                  AND inv.normalized_name = i.normalized_name
                )
            ) THEN 1 ELSE 0 END) AS covered_count
          FROM recipes r
          JOIN recipe_ingredients ri ON ri.recipe_id = r.id
          JOIN ingredients i ON i.id = ri.ingredient_id
          WHERE r.is_active = 1 AND ri.is_optional = 0
          GROUP BY r.id, r.title
        ), ranked AS (
          SELECT
            recipe_id, title, covered_count, total_count,
            CAST(covered_count * 1000000 / total_count AS INTEGER)
              AS coverage_key
          FROM coverage
          WHERE (@mode = 'all' OR covered_count > 0)
        )
        SELECT recipe_id, title, covered_count, total_count, coverage_key
        FROM ranked
        WHERE (
          @cursor_coverage IS NULL
          OR coverage_key < @cursor_coverage
          OR (
            coverage_key = @cursor_coverage
            AND recipe_id > @cursor_recipe_id
          )
        )
        ORDER BY coverage_key DESC, recipe_id ASC
        LIMIT @row_limit
      `).all({
        mode: request.mode,
        cursor_coverage: cursor?.coverageKey ?? null,
        cursor_recipe_id: cursor?.recipeId ?? null,
        row_limit: request.limit + 1,
      }) as MatchRow[];
      const hasNextPage = rows.length > request.limit;
      const pageRows = hasNextPage ? rows.slice(0, request.limit) : rows;
      const items = pageRows.map((row) => {
        const missing = this.db.prepare(`
          SELECT i.canonical_name
          FROM recipe_ingredients ri
          JOIN ingredients i ON i.id = ri.ingredient_id
          WHERE ri.recipe_id = ? AND ri.is_optional = 0
            AND NOT EXISTS (
              SELECT 1 FROM inventory_items inv
              WHERE inv.ingredient_id = ri.ingredient_id
                OR (
                  inv.ingredient_id IS NULL
                  AND inv.normalized_name = i.normalized_name
                )
            )
          ORDER BY ri.position ASC, ri.id ASC
        `).all(row.recipe_id) as Array<{ readonly canonical_name: string }>;
        return {
          recipeId: row.recipe_id,
          title: row.title,
          coveredIngredients: row.covered_count,
          totalIngredients: row.total_count,
          coverage: row.coverage_key / 1_000_000,
          missingIngredients: missing.map((item) => item.canonical_name),
        };
      });
      const last = pageRows.at(-1);
      return recipeMatchPageSchema.parse({
        items,
        nextCursor: hasNextPage && last !== undefined
          ? encodeMatchCursor({
            mode: request.mode,
            coverageKey: last.coverage_key,
            recipeId: last.recipe_id,
            inventoryVersion,
            catalogVersion,
          })
          : null,
      });
    });
    return read.deferred();
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

    let normalizedUnit: Unit;
    try {
      normalizedUnit = requireUnit(requestedUnit);
    } catch {
      throw new AppError('unsupported_unit', '单位不受支持', 400);
    }
    if (!canConvertUnit(currentUnit, normalizedUnit)) {
      throw new AppError(
        'incompatible_unit_family',
        '跨单位类型修改时必须同时填写数量',
        400,
      );
    }
    return { quantity: currentQuantity, unit: currentUnit };
  }

  private normalizeQuantity(
    quantity: number,
    unit: string,
  ): { readonly quantity: number; readonly unit: Unit } {
    try {
      return toBaseQuantity(quantity, unit);
    } catch {
      throw new AppError('unsupported_unit', '单位不受支持', 400);
    }
  }

  private getRow(itemId: string): InventoryRow | undefined {
    return this.db.prepare(`
      SELECT
        id, ingredient_id, canonical_name, normalized_name, quantity, unit,
        category, source, confirmed_at, updated_at, version
      FROM inventory_items WHERE id = ?
    `).get(itemId) as InventoryRow | undefined;
  }

  private getDataVersion(scope: string): number {
    const row = this.db.prepare(`
      SELECT version FROM app_data_versions WHERE scope = ?
    `).get(scope) as { readonly version: number } | undefined;
    if (row === undefined) {
      throw new Error(`Missing data version: ${scope}`);
    }
    return row.version;
  }

  private bumpDataVersion(scope: string): void {
    const result = this.db.prepare(`
      UPDATE app_data_versions SET version = version + 1 WHERE scope = ?
    `).run(scope);
    if (result.changes !== 1) {
      throw new Error(`Missing data version: ${scope}`);
    }
  }
}
