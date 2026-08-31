import {
  canConvertUnit,
  convertUnit,
  requireUnit,
  toBaseQuantity,
  type Unit,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';

interface ConversionRow {
  readonly from_unit: Unit;
  readonly to_unit: Unit;
  readonly factor: number;
}

const convertWithinFamily = (
  quantity: number,
  from: Unit,
  to: Unit,
): number | undefined => {
  if (!canConvertUnit(from, to)) {
    return undefined;
  }
  return convertUnit(quantity, from, to);
};

/** Applies global same-family rules, then explicit ingredient-specific bridges. */
export class IngredientUnitConverter {
  constructor(private readonly db: Database.Database) {}

  normalize(
    quantity: number,
    unitInput: string,
  ): { readonly quantity: number; readonly unit: Unit } {
    return toBaseQuantity(quantity, unitInput);
  }

  convert(
    quantity: number,
    fromInput: string,
    toInput: string,
    ingredientId: string | null,
  ): number | undefined {
    const from = requireUnit(fromInput);
    const to = requireUnit(toInput);
    const standard = convertWithinFamily(quantity, from, to);
    if (standard !== undefined) {
      return standard;
    }
    if (ingredientId === null) {
      return undefined;
    }

    const rows = this.db.prepare(`
      SELECT from_unit, to_unit, factor
      FROM ingredient_unit_conversions
      WHERE ingredient_id = ?
      ORDER BY from_unit ASC, to_unit ASC
    `).all(ingredientId) as ConversionRow[];
    for (const row of rows) {
      const inDeclaredFrom = convertWithinFamily(quantity, from, row.from_unit);
      if (inDeclaredFrom !== undefined) {
        const converted = inDeclaredFrom * row.factor;
        const inRequestedTo = convertWithinFamily(
          converted,
          row.to_unit,
          to,
        );
        if (inRequestedTo !== undefined) {
          return inRequestedTo;
        }
      }

      const inDeclaredTo = convertWithinFamily(quantity, from, row.to_unit);
      if (inDeclaredTo !== undefined) {
        const converted = inDeclaredTo / row.factor;
        const inRequestedFrom = convertWithinFamily(
          converted,
          row.from_unit,
          to,
        );
        if (inRequestedFrom !== undefined) {
          return inRequestedFrom;
        }
      }
    }
    return undefined;
  }
}
