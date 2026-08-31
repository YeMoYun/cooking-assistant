import {
  normalizeUnit,
  recipeVariantSchema,
  type RecipeVariant,
} from '@xiaochu/shared';
import {
  FOOD_SAFETY_RULESET_VERSION,
  validateFoodSafety,
  type FoodSafetyIssue,
} from './food-safety-rules.js';
import type { VariantSourceRecipe } from './variant-types.js';

export const RECIPE_VARIANT_VALIDATOR_VERSION = `variant-validator/1+${FOOD_SAFETY_RULESET_VERSION}`;

export interface VariantValidationIssue {
  readonly code:
    | 'invalid_schema'
    | 'unknown_unit'
    | 'duplicate_ingredient'
    | 'duplicate_step_ingredient'
    | 'missing_ingredient_reference'
    | 'unused_required_ingredient'
    | 'discontinuous_steps'
    | FoodSafetyIssue['code'];
  readonly path: string;
  readonly minimumCelsius?: number;
}

export interface ValidatedRecipeVariant {
  readonly recipe: RecipeVariant;
  readonly safetyWarnings: readonly string[];
}

export class RecipeVariantValidationError extends Error {
  constructor(public readonly issues: readonly VariantValidationIssue[]) {
    super('Recipe variant failed deterministic validation');
    this.name = 'RecipeVariantValidationError';
  }
}

const identity = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}\s]+/gu, '')
  .trim();

const issuePath = (path: readonly PropertyKey[]): string => path
  .map((part) => String(part))
  .join('.');

const schemaIssues = (input: unknown): RecipeVariant => {
  const parsed = recipeVariantSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecipeVariantValidationError(
      parsed.error.issues.slice(0, 50).map((issue) => ({
        code: 'invalid_schema',
        path: issuePath(issue.path),
      })),
    );
  }
  return parsed.data;
};

/**
 * Validates model output without trusting its prose claims, normalizing only
 * units already recognized by the application's fixed unit dictionary.
 */
export const validateRecipeVariant = (
  input: unknown,
  sourceRecipe: VariantSourceRecipe,
): ValidatedRecipeVariant => {
  const parsed = schemaIssues(input);
  const issues: VariantValidationIssue[] = [];
  const canonicalIngredients = parsed.ingredients.map((ingredient, index) => {
    const unit = normalizeUnit(ingredient.unit);
    if (unit === undefined) {
      issues.push({
        code: 'unknown_unit',
        path: `ingredients.${index}.unit`,
      });
      return ingredient;
    }
    return { ...ingredient, unit };
  });

  const ingredientNameByIdentity = new Map<string, string>();
  canonicalIngredients.forEach((ingredient, index) => {
    const key = identity(ingredient.name);
    if (ingredientNameByIdentity.has(key)) {
      issues.push({
        code: 'duplicate_ingredient',
        path: `ingredients.${index}.name`,
      });
      return;
    }
    ingredientNameByIdentity.set(key, ingredient.name);
  });

  const referencedNames = new Set<string>();
  const canonicalSteps = parsed.steps.map((step, stepIndex) => {
    if (step.number !== stepIndex + 1) {
      issues.push({
        code: 'discontinuous_steps',
        path: `steps.${stepIndex}.number`,
      });
    }

    const stepReferences = new Set<string>();
    const ingredientNames = step.ingredientNames.map((name, referenceIndex) => {
      const key = identity(name);
      const canonicalName = ingredientNameByIdentity.get(key);
      if (canonicalName === undefined) {
        issues.push({
          code: 'missing_ingredient_reference',
          path: `steps.${stepIndex}.ingredientNames.${referenceIndex}`,
        });
        return name;
      }
      if (stepReferences.has(key)) {
        issues.push({
          code: 'duplicate_step_ingredient',
          path: `steps.${stepIndex}.ingredientNames.${referenceIndex}`,
        });
      }
      stepReferences.add(key);
      referencedNames.add(key);
      return canonicalName;
    });
    return { ...step, ingredientNames };
  });

  canonicalIngredients.forEach((ingredient, index) => {
    if (!ingredient.optional && !referencedNames.has(identity(ingredient.name))) {
      issues.push({
        code: 'unused_required_ingredient',
        path: `ingredients.${index}.name`,
      });
    }
  });

  if (issues.length > 0) {
    throw new RecipeVariantValidationError(issues.slice(0, 100));
  }

  const canonicalRecipe = recipeVariantSchema.parse({
    ...parsed,
    ingredients: canonicalIngredients,
    steps: canonicalSteps,
  });
  const safety = validateFoodSafety(sourceRecipe, canonicalRecipe);
  if (safety.issues.length > 0) {
    throw new RecipeVariantValidationError(safety.issues.slice(0, 100).map(
      (issue) => ({
        code: issue.code,
        path: issue.stepNumber === undefined
          ? 'steps'
          : `steps.${issue.stepNumber - 1}.safetyRequirement`,
        minimumCelsius: issue.minimumCelsius,
      }),
    ));
  }

  return {
    recipe: canonicalRecipe,
    safetyWarnings: safety.warnings,
  };
};

