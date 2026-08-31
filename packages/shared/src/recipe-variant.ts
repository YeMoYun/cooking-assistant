import { z } from 'zod';
import { opaqueActionIdSchema } from './pending-action.js';

const boundedText = (maximumLength: number) => z.string()
  .trim()
  .min(1)
  .max(maximumLength);

const recipeIdSchema = boundedText(100);
const variantIdSchema = z.string().uuid();
const providerIdSchema = z.string().uuid();
const positiveQuantitySchema = z.number().finite().positive().max(1_000_000_000);
const timestampSchema = z.string().datetime({ offset: true });

export const recipeVariantIngredientSchema = z.object({
  name: boundedText(80),
  quantity: positiveQuantitySchema,
  unit: boundedText(20),
  optional: z.boolean(),
}).strict();

export const recipeVariantStepSchema = z.object({
  number: z.number().int().positive().max(500),
  instruction: boundedText(2_000),
  ingredientNames: z.array(boundedText(80)).max(100),
  completionCue: boundedText(500),
  safetyRequirement: z.string().trim().max(500).optional(),
}).strict();

/** Strict structured output accepted from a recipe-variant model. */
export const recipeVariantSchema = z.object({
  title: boundedText(120),
  servings: positiveQuantitySchema,
  ingredients: z.array(recipeVariantIngredientSchema).min(1).max(500),
  steps: z.array(recipeVariantStepSchema).min(1).max(500),
  change_summary: z.array(boundedText(500)).min(1).max(100),
  safety_warnings: z.array(boundedText(500)).max(100),
}).strict();

export const recipeVariantAdjustmentSchema = z.object({
  lessOil: z.boolean(),
  lessSalt: z.boolean(),
  noSugar: z.boolean(),
  spiceLevel: z.enum(['unchanged', 'milder', 'spicier']),
}).strict();

export const recipeVariantSubstitutionSchema = z.object({
  ingredient: boundedText(80),
  replacement: boundedText(80).nullable(),
  reason: z.string().trim().max(200).optional(),
}).strict().superRefine((value, context) => {
  if (
    value.replacement !== null
    && value.ingredient.normalize('NFKC').toLocaleLowerCase('zh-CN')
      === value.replacement.normalize('NFKC').toLocaleLowerCase('zh-CN')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['replacement'],
      message: 'Replacement must differ from the original ingredient',
    });
  }
});

export const recipeVariantPreviewInputSchema = z.object({
  providerId: providerIdSchema,
  targetServings: z.number().finite().positive().max(1_000).optional(),
  adjustments: recipeVariantAdjustmentSchema.default({
    lessOil: false,
    lessSalt: false,
    noSugar: false,
    spiceLevel: 'unchanged',
  }),
  dietaryRequirements: z.array(boundedText(200)).max(20).default([]),
  substitutions: z.array(recipeVariantSubstitutionSchema).max(50).default([]),
  customRequirements: z.string().trim().max(2_000).optional(),
  inventoryItemIds: z.array(z.string().uuid()).max(100).default([]),
}).strict().superRefine((value, context) => {
  const inventoryIds = new Set(value.inventoryItemIds);
  if (inventoryIds.size !== value.inventoryItemIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['inventoryItemIds'],
      message: 'Inventory selections must be unique',
    });
  }

  const substitutions = new Set<string>();
  value.substitutions.forEach((substitution, index) => {
    const key = substitution.ingredient
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN');
    if (substitutions.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['substitutions', index, 'ingredient'],
        message: 'Each ingredient may be substituted only once',
      });
    }
    substitutions.add(key);
  });

  const hasAdjustment = value.adjustments.lessOil
    || value.adjustments.lessSalt
    || value.adjustments.noSugar
    || value.adjustments.spiceLevel !== 'unchanged';
  const hasCustomRequirement = value.customRequirements !== undefined
    && value.customRequirements.length > 0;
  if (
    value.targetServings === undefined
    && !hasAdjustment
    && value.dietaryRequirements.length === 0
    && value.substitutions.length === 0
    && !hasCustomRequirement
    && value.inventoryItemIds.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      message: 'At least one recipe change must be requested',
    });
  }
});

export const confirmRecipeVariantInputSchema = z.object({
  pendingActionId: opaqueActionIdSchema,
}).strict();

export const recipeVariantDiffSchema = z.object({
  ingredientChanges: z.array(boundedText(500)).max(100),
  stepChanges: z.array(boundedText(1_000)).max(100),
  safetyWarnings: z.array(boundedText(1_000)).max(100),
}).strict();

export const recipeVariantSummarySchema = z.object({
  id: variantIdSchema,
  sourceRecipeId: recipeIdSchema,
  sourceRecipeTitle: boundedText(100),
  name: boundedText(120),
  servings: positiveQuantitySchema,
  validatorVersion: boundedText(50),
  createdAt: timestampSchema,
}).strict();

export const recipeVariantDetailSchema = recipeVariantSummarySchema.extend({
  request: recipeVariantPreviewInputSchema,
  result: recipeVariantSchema,
}).strict();

export const recipeVariantListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const recipeVariantPageSchema = z.object({
  items: z.array(recipeVariantSummarySchema),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();

export const recipeVariantIdParamsSchema = z.object({
  variantId: variantIdSchema,
}).strict();

export type RecipeVariant = z.infer<typeof recipeVariantSchema>;
export type RecipeVariantIngredient = z.infer<
  typeof recipeVariantIngredientSchema
>;
export type RecipeVariantStep = z.infer<typeof recipeVariantStepSchema>;
export type RecipeVariantPreviewInput = z.infer<
  typeof recipeVariantPreviewInputSchema
>;
export type RecipeVariantDiff = z.infer<typeof recipeVariantDiffSchema>;
export type RecipeVariantSummary = z.infer<
  typeof recipeVariantSummarySchema
>;
export type RecipeVariantDetail = z.infer<typeof recipeVariantDetailSchema>;
export type RecipeVariantPage = z.infer<typeof recipeVariantPageSchema>;
