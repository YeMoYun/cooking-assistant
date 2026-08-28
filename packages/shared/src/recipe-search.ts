import { z } from 'zod';

export const recipeDifficultySchema = z.enum(['easy', 'medium', 'hard']);
export const recipeTierSchema = z.enum(['standard', 'video', 'detailed']);

const optionalFilterSchema = z.string().trim().min(1).max(50).optional();

export const recipeSearchQuerySchema = z.object({
  q: z.string().trim().max(100).default(''),
  difficulty: recipeDifficultySchema.optional(),
  maxMinutes: z.coerce.number().int().min(1).max(1_440).optional(),
  taste: optionalFilterSchema,
  technique: optionalFilterSchema,
  tier: recipeTierSchema.optional(),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const recipeCardSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(500),
  coverUrl: z.string().url().optional(),
  totalMinutes: z.number().int().positive(),
  difficulty: recipeDifficultySchema,
  tier: recipeTierSchema,
  hasVideo: z.boolean(),
}).strict();

export const recipePageSchema = z.object({
  items: z.array(recipeCardSchema),
  nextCursor: z.string().min(1).optional(),
}).strict();

export type RecipeDifficulty = z.infer<typeof recipeDifficultySchema>;
export type RecipeTier = z.infer<typeof recipeTierSchema>;
export type RecipeSearchQuery = z.infer<typeof recipeSearchQuerySchema>;
export type RecipeCard = z.infer<typeof recipeCardSchema>;
export type RecipePage = z.infer<typeof recipePageSchema>;
