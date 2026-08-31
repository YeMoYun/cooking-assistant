import {
  recipeVariantDiffSchema,
  type RecipeVariant,
  type RecipeVariantDiff,
} from '@xiaochu/shared';
import type { VariantSourceRecipe } from './variant-types.js';

const identity = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}\s]+/gu, '')
  .trim();

const formatQuantity = (value: number): string => String(
  Math.round((value + Number.EPSILON) * 100) / 100,
);

const boundedChanges = (
  values: readonly string[],
  maximum: number,
  overflowLabel: string,
): string[] => {
  const unique = [...new Set(values)];
  if (unique.length <= maximum) {
    return unique;
  }
  return [
    ...unique.slice(0, maximum - 1),
    `${overflowLabel}（另有 ${unique.length - maximum + 1} 项）`,
  ];
};

export const diffRecipeVariant = (
  source: VariantSourceRecipe,
  variant: RecipeVariant,
  derivedSafetyWarnings: readonly string[] = [],
): RecipeVariantDiff => {
  const ingredientChanges: string[] = [];
  const sourceIngredients = new Map(
    source.ingredients.map((ingredient) => [identity(ingredient.name), ingredient]),
  );
  const variantIngredients = new Map(
    variant.ingredients.map((ingredient) => [identity(ingredient.name), ingredient]),
  );

  for (const [key, ingredient] of sourceIngredients) {
    const changed = variantIngredients.get(key);
    if (changed === undefined) {
      ingredientChanges.push(`移除：${ingredient.name}`);
      continue;
    }
    if (
      ingredient.quantity !== changed.quantity
      || ingredient.unit !== changed.unit
    ) {
      ingredientChanges.push(
        `${ingredient.name}：${formatQuantity(ingredient.quantity)}${ingredient.unit} → ${formatQuantity(changed.quantity)}${changed.unit}`,
      );
    }
    if (ingredient.optional !== changed.optional) {
      ingredientChanges.push(
        `${ingredient.name}：${changed.optional ? '改为可选' : '改为必需'}`,
      );
    }
  }
  for (const [key, ingredient] of variantIngredients) {
    if (!sourceIngredients.has(key)) {
      ingredientChanges.push(
        `新增：${ingredient.name} ${formatQuantity(ingredient.quantity)}${ingredient.unit}${ingredient.optional ? '（可选）' : ''}`,
      );
    }
  }

  const stepChanges: string[] = [];
  if (source.title !== variant.title) {
    stepChanges.push(`标题：《${source.title}》→《${variant.title}》`);
  }
  if (source.servings !== variant.servings) {
    stepChanges.push(
      `份量：${formatQuantity(source.servings)} 人份 → ${formatQuantity(variant.servings)} 人份`,
    );
  }
  const sourceSteps = new Map(source.steps.map((step) => [step.number, step]));
  const variantSteps = new Map(variant.steps.map((step) => [step.number, step]));
  for (const [number, sourceStep] of sourceSteps) {
    const changed = variantSteps.get(number);
    if (changed === undefined) {
      stepChanges.push(`移除第 ${number} 步`);
      continue;
    }
    const sourceIngredientKeys = sourceStep.ingredientNames.map(identity).join('|');
    const changedIngredientKeys = changed.ingredientNames.map(identity).join('|');
    const changedParts: string[] = [];
    if (sourceStep.instruction !== changed.instruction) {
      changedParts.push('操作');
    }
    if (sourceIngredientKeys !== changedIngredientKeys) {
      changedParts.push('食材');
    }
    if ((sourceStep.completionCue ?? '') !== changed.completionCue) {
      changedParts.push('完成状态');
    }
    if (
      (sourceStep.safetyRequirement ?? '')
      !== (changed.safetyRequirement ?? '')
    ) {
      changedParts.push('安全要求');
    }
    if (changedParts.length > 0) {
      stepChanges.push(`第 ${number} 步修改：${changedParts.join('、')}`);
    }
  }
  for (const number of variantSteps.keys()) {
    if (!sourceSteps.has(number)) {
      stepChanges.push(`新增第 ${number} 步`);
    }
  }

  return recipeVariantDiffSchema.parse({
    ingredientChanges: boundedChanges(ingredientChanges, 100, '更多食材变化'),
    stepChanges: boundedChanges(stepChanges, 100, '更多步骤变化'),
    safetyWarnings: boundedChanges(
      [...variant.safety_warnings, ...derivedSafetyWarnings],
      100,
      '更多食品安全提示',
    ),
  });
};

