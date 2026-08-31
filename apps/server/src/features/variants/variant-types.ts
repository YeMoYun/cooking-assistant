import type {
  KitchenCategory,
  RecipeVariant,
  RecipeVariantDiff,
  RecipeVariantPreviewInput,
  Unit,
} from '@xiaochu/shared';

export interface VariantSourceIngredient {
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
  readonly optional: boolean;
}

export interface VariantSourceStep {
  readonly number: number;
  readonly instruction: string;
  readonly ingredientNames: readonly string[];
  readonly completionCue: string | null;
  readonly safetyRequirement: string | null;
}

export interface VariantSourceRecipe {
  readonly id: string;
  readonly title: string;
  readonly servings: number;
  readonly contentVersion: string;
  readonly contentHash: string;
  readonly ingredients: readonly VariantSourceIngredient[];
  readonly steps: readonly VariantSourceStep[];
}

export interface VariantInventoryItem {
  readonly id: string;
  readonly ingredientId: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly category: KitchenCategory;
}

export interface VariantPreviewContext {
  readonly sourceRecipe: VariantSourceRecipe;
  readonly inventoryItems: readonly VariantInventoryItem[];
  readonly dataVersions: Readonly<Record<string, number>>;
}

export interface StoredVariantPendingPayload {
  readonly sourceRecipeId: string;
  readonly sourceContentVersion: string;
  readonly sourceContentHash: string;
  readonly request: RecipeVariantPreviewInput;
  readonly result: RecipeVariant;
  readonly diff: RecipeVariantDiff;
  readonly validatorVersion: string;
}
