import { z } from 'zod';

export const opaqueActionIdSchema = z.string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

const pendingActionBaseShape = {
  pendingActionId: opaqueActionIdSchema,
  title: z.string().min(1).max(100),
  expiresAt: z.string().datetime({ offset: true }),
} as const;

const shoppingPreviewItemSchema = z.object({
  name: z.string().min(1).max(80),
  quantity: z.number().finite().positive(),
  unit: z.string().min(1).max(20),
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

export const pendingActionPreviewSchema = z.discriminatedUnion('kind', [
  z.object({
    ...pendingActionBaseShape,
    kind: z.literal('shopping_items'),
    preview: z.object({
      items: z.array(shoppingPreviewItemSchema).max(500),
    }).strict(),
  }).strict(),
  z.object({
    ...pendingActionBaseShape,
    kind: z.literal('recipe_variant'),
    preview: z.object({
      ingredientChanges: z.array(z.string().min(1).max(500)).max(100),
      stepChanges: z.array(z.string().min(1).max(1_000)).max(100),
      safetyWarnings: z.array(z.string().min(1).max(1_000)).max(100),
    }).strict(),
  }).strict(),
  z.object({
    ...pendingActionBaseShape,
    kind: z.literal('note'),
    preview: z.object({
      body: z.string().min(1).max(10_000),
      recipeId: z.string().min(1).max(100).optional(),
    }).strict(),
  }).strict(),
]);

export const pendingActionConfirmationSchema = z.object({
  pendingActionId: opaqueActionIdSchema,
}).strict();

export type PendingActionPreview = z.infer<typeof pendingActionPreviewSchema>;
