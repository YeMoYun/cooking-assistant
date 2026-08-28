import { z } from 'zod';
import {
  recipeCardSchema,
  recipeDifficultySchema,
} from './recipe-search.js';

const publicIdSchema = z.string().min(1).max(140);
const recipeIdSchema = z.string().min(1).max(100);
const timestampSchema = z.string().datetime({ offset: true });
const nullableHttpsUrlSchema = z.string().url().refine(
  (value) => new URL(value).protocol === 'https:',
  'URL must use HTTPS',
).nullable();

export const recipeCoverSchema = z.object({
  url: nullableHttpsUrlSchema,
  alt: z.string().min(1).max(200),
}).strict();

const mediaHealthSchema = z.object({
  healthStatus: z.enum([
    'unchecked',
    'healthy',
    'degraded',
    'unavailable',
  ]),
  lastCheckedAt: timestampSchema.nullable(),
}).strict();

const mediaBaseShape = {
  id: publicIdSchema,
  provider: z.string().min(1).max(50),
  posterUrl: nullableHttpsUrlSchema,
  health: mediaHealthSchema,
} as const;

export const recipeDetailMediaSchema = z.discriminatedUnion('kind', [
  z.object({
    ...mediaBaseShape,
    kind: z.literal('html5'),
    url: z.string().url(),
  }).strict(),
  z.object({
    ...mediaBaseShape,
    kind: z.literal('iframe'),
    embedUrl: z.string().url(),
  }).strict(),
  z.object({
    ...mediaBaseShape,
    kind: z.literal('external'),
    url: z.string().url(),
  }).strict(),
]);

export const recipeDetailIngredientSchema = z.object({
  id: publicIdSchema,
  name: z.string().min(1).max(80),
  category: z.enum([
    'produce',
    'meat_egg_dairy',
    'staple',
    'seasoning',
    'other',
  ]),
  quantity: z.number().finite().positive(),
  unit: z.string().min(1).max(20),
  optional: z.boolean(),
  note: z.string().min(1).max(200).nullable(),
}).strict();

const standardRecipeStepSchema = z.object({
  id: publicIdSchema,
  number: z.number().int().positive(),
  instruction: z.string().min(1).max(2_000),
  ingredientNames: z.array(z.string().min(1).max(80)).max(30),
}).strict();

const detailedRecipeStepSchema = standardRecipeStepSchema.extend({
  durationSecondsMin: z.number().int().positive(),
  durationSecondsMax: z.number().int().positive(),
  heatOrDevice: z.string().min(1).max(200),
  completionCue: z.string().min(1).max(500),
  commonMistake: z.string().min(1).max(500),
  safetyRequirement: z.string().min(1).max(500),
}).strict().refine(
  (step) => step.durationSecondsMin <= step.durationSecondsMax,
  {
    path: ['durationSecondsMax'],
    message: 'Maximum duration cannot be less than minimum duration',
  },
);

export const recipeNoteSchema = z.object({
  id: z.string().uuid(),
  recipeId: recipeIdSchema,
  body: z.string().min(1).max(10_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const recipeDetailBaseShape = {
  id: recipeIdSchema,
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(500),
  difficulty: recipeDifficultySchema,
  servings: z.number().finite().positive(),
  prepMinutes: z.number().int().nonnegative(),
  cookMinutes: z.number().int().positive(),
  totalMinutes: z.number().int().positive(),
  cover: recipeCoverSchema,
  favorite: z.boolean(),
  tags: z.array(z.string().min(1).max(50)).max(30),
  tastes: z.array(z.string().min(1).max(50)).max(10),
  techniques: z.array(z.string().min(1).max(50)).max(10),
  ingredients: z.array(recipeDetailIngredientSchema).min(1),
  notes: z.array(recipeNoteSchema),
} as const;

export const standardRecipeDetailSchema = z.object({
  ...recipeDetailBaseShape,
  tier: z.literal('standard'),
  steps: z.array(standardRecipeStepSchema).min(1),
}).strict();

export const videoRecipeDetailSchema = z.object({
  ...recipeDetailBaseShape,
  tier: z.literal('video'),
  media: z.array(recipeDetailMediaSchema).min(1).max(5),
  steps: z.array(standardRecipeStepSchema).min(1),
}).strict();

export const detailedRecipeDetailSchema = z.object({
  ...recipeDetailBaseShape,
  tier: z.literal('detailed'),
  media: z.array(recipeDetailMediaSchema).min(1).max(5),
  steps: z.array(detailedRecipeStepSchema).min(1),
}).strict();

export const recipeDetailSchema = z.discriminatedUnion('tier', [
  standardRecipeDetailSchema,
  videoRecipeDetailSchema,
  detailedRecipeDetailSchema,
]);

export const recipeCollectionItemSchema = recipeCardSchema;

export const favoriteRecipeItemSchema = recipeCollectionItemSchema.extend({
  favoritedAt: timestampSchema,
}).strict();

export const favoriteRecipePageSchema = z.object({
  items: z.array(favoriteRecipeItemSchema),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();

export const recentRecipeItemSchema = recipeCollectionItemSchema.extend({
  lastViewedAt: timestampSchema,
}).strict();

export const recentRecipeListSchema = z.object({
  items: z.array(recentRecipeItemSchema),
}).strict();

export const favoriteMutationResultSchema = z.object({
  recipeId: recipeIdSchema,
  favorite: z.boolean(),
}).strict();

export const recentViewMutationResultSchema = z.object({
  recipeId: recipeIdSchema,
  lastViewedAt: timestampSchema,
}).strict();

export const recipeIdParamsSchema = z.object({
  recipeId: recipeIdSchema,
}).strict();

export const recipeNoteIdParamsSchema = z.object({
  noteId: z.string().uuid(),
}).strict();

export const favoriteRecipeQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const recentRecipeQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const createRecipeNoteInputSchema = z.object({
  noteId: z.string().uuid(),
  recipeId: recipeIdSchema,
  body: z.string().trim().min(1).max(10_000),
}).strict();

export const updateRecipeNoteInputSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
}).strict();

export type RecipeDetail = z.infer<typeof recipeDetailSchema>;
export type RecipeDetailMedia = z.infer<typeof recipeDetailMediaSchema>;
export type RecipeCollectionItem = z.infer<typeof recipeCollectionItemSchema>;
export type FavoriteRecipePage = z.infer<typeof favoriteRecipePageSchema>;
export type RecentRecipeList = z.infer<typeof recentRecipeListSchema>;
export type RecipeNote = z.infer<typeof recipeNoteSchema>;
export type CreateRecipeNoteInput = z.infer<
  typeof createRecipeNoteInputSchema
>;
export type UpdateRecipeNoteInput = z.infer<
  typeof updateRecipeNoteInputSchema
>;
