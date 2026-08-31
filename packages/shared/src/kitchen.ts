import { z } from 'zod';
import { unitValues } from './units.js';

export const kitchenCategorySchema = z.enum([
  'produce',
  'meat_egg_dairy',
  'staple',
  'seasoning',
  'other',
]);
export const kitchenUnitSchema = z.enum(unitValues);
const itemIdSchema = z.string().uuid();
const ingredientIdSchema = z.string().min(1).max(100).nullable();
const itemNameSchema = z.string().trim().min(1).max(80);
const timestampSchema = z.string().datetime({ offset: true });
const positiveQuantitySchema = z.number().finite().positive().max(1_000_000_000);

export const inventoryItemSchema = z.object({
  id: itemIdSchema,
  ingredientId: ingredientIdSchema,
  name: itemNameSchema,
  quantity: positiveQuantitySchema,
  unit: kitchenUnitSchema,
  category: kitchenCategorySchema,
  source: z.enum(['manual', 'vision', 'shopping']),
  confirmedAt: timestampSchema,
  updatedAt: timestampSchema,
  version: z.number().int().positive(),
}).strict();

export const inventorySnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  items: z.array(inventoryItemSchema),
}).strict();

export const createInventoryItemSchema = z.object({
  itemId: itemIdSchema,
  ingredientId: ingredientIdSchema.optional().default(null),
  name: itemNameSchema,
  quantity: positiveQuantitySchema,
  unit: z.string().trim().min(1).max(20),
  category: kitchenCategorySchema,
  source: z.enum(['manual', 'vision']).default('manual'),
}).strict();

export const updateInventoryItemSchema = z.object({
  expectedVersion: z.number().int().positive(),
  ingredientId: ingredientIdSchema.optional(),
  name: itemNameSchema.optional(),
  quantity: positiveQuantitySchema.optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  category: kitchenCategorySchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 1, {
  message: 'At least one field must be updated',
});

export const versionedItemParamsSchema = z.object({
  itemId: itemIdSchema,
}).strict();

export const deleteVersionQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
}).strict();

export const shoppingItemSchema = z.object({
  id: itemIdSchema,
  ingredientId: ingredientIdSchema,
  name: itemNameSchema,
  quantity: positiveQuantitySchema,
  unit: kitchenUnitSchema,
  category: kitchenCategorySchema,
  requiresReview: z.boolean(),
  checked: z.boolean(),
  sources: z.array(z.string().min(1).max(100)).max(50),
  source: z.enum(['manual', 'generated']),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  version: z.number().int().positive(),
}).strict();

export const shoppingSnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  items: z.array(shoppingItemSchema),
}).strict();

export const createShoppingItemSchema = z.object({
  itemId: itemIdSchema,
  ingredientId: ingredientIdSchema.optional().default(null),
  name: itemNameSchema,
  quantity: positiveQuantitySchema,
  unit: z.string().trim().min(1).max(20),
  category: kitchenCategorySchema,
}).strict();

export const updateShoppingItemSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: itemNameSchema.optional(),
  quantity: positiveQuantitySchema.optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  category: kitchenCategorySchema.optional(),
  checked: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 1, {
  message: 'At least one field must be updated',
});

const recipeSelectionSchema = z.object({
  recipeId: z.string().min(1).max(100),
  servings: z.number().finite().positive().max(1_000),
}).strict();

export const generateShoppingPreviewSchema = z.object({
  recipes: z.array(recipeSelectionSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.recipes.forEach((recipe, index) => {
    if (ids.has(recipe.recipeId)) {
      context.addIssue({
        code: 'custom',
        path: ['recipes', index, 'recipeId'],
        message: 'Recipe selections must be unique',
      });
    }
    ids.add(recipe.recipeId);
  });
});

export const addShoppingItemToInventorySchema = z.object({
  inventoryItemId: itemIdSchema,
}).strict();

export const recipeMatchQuerySchema = z.object({
  mode: z.enum(['all', 'best']).default('best'),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const recipeMatchSchema = z.object({
  recipeId: z.string().min(1).max(100),
  title: z.string().min(1).max(100),
  coveredIngredients: z.number().int().nonnegative(),
  totalIngredients: z.number().int().positive(),
  coverage: z.number().min(0).max(1),
  missingIngredients: z.array(z.string().min(1).max(80)),
}).strict();

export const recipeMatchPageSchema = z.object({
  items: z.array(recipeMatchSchema),
  nextCursor: z.string().min(1).max(1_024).nullable(),
}).strict();

export type KitchenCategory = z.infer<typeof kitchenCategorySchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type InventorySnapshot = z.infer<typeof inventorySnapshotSchema>;
export type CreateInventoryItem = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItem = z.infer<typeof updateInventoryItemSchema>;
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;
export type ShoppingSnapshot = z.infer<typeof shoppingSnapshotSchema>;
export type CreateShoppingItem = z.infer<typeof createShoppingItemSchema>;
export type UpdateShoppingItem = z.infer<typeof updateShoppingItemSchema>;
export type GenerateShoppingPreview = z.infer<
  typeof generateShoppingPreviewSchema
>;
export type RecipeMatchPage = z.infer<typeof recipeMatchPageSchema>;
