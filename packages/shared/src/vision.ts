import { z } from 'zod';
import {
  inventoryItemSchema,
  kitchenCategorySchema,
  kitchenUnitSchema,
} from './kitchen.js';

export const VISION_MAX_ITEMS = 100;
export const VISION_CONFIRM_MAX_BYTES = 64 * 1_024;

const ingredientNameSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), {
    message: 'Ingredient name contains control characters',
  });

const quantitySchema = z.number().finite().positive().max(1_000_000_000);

/** Strict wire result requested from the vision model. */
export const visionResultSchema = z.object({
  items: z.array(z.object({
    name: ingredientNameSchema,
    quantity: quantitySchema,
    unit: z.string().trim().min(1).max(20),
    confidence: z.number().finite().min(0).max(1),
    needs_confirmation: z.boolean(),
  }).strict()).max(VISION_MAX_ITEMS),
}).strict();

export const visionConfirmationReasonSchema = z.enum([
  'low_confidence',
  'ingredient_unmapped',
  'ingredient_mapping_ambiguous',
  'unknown_unit',
]);

export const visionCandidateSchema = z.object({
  name: ingredientNameSchema,
  quantity: quantitySchema,
  unit: z.string().trim().min(1).max(20),
  confidence: z.number().finite().min(0).max(1),
  ingredientId: z.string().min(1).max(100).nullable(),
  category: kitchenCategorySchema,
  needsConfirmation: z.literal(true),
  reasons: z.array(visionConfirmationReasonSchema)
    .max(visionConfirmationReasonSchema.options.length),
}).strict();

const opaqueRecognitionIdSchema = z.string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const recognitionPreviewSchema = z.object({
  recognitionId: opaqueRecognitionIdSchema,
  expiresAt: z.string().datetime({ offset: true }),
  candidates: z.array(visionCandidateSchema).max(VISION_MAX_ITEMS),
}).strict();

export const confirmRecognitionParamsSchema = z.object({
  recognitionId: opaqueRecognitionIdSchema,
}).strict();

export const confirmRecognitionItemSchema = z.object({
  name: ingredientNameSchema,
  quantity: quantitySchema,
  unit: kitchenUnitSchema,
  category: kitchenCategorySchema.optional().default('other'),
}).strict();

export const confirmRecognitionInputSchema = z.object({
  items: z.array(confirmRecognitionItemSchema).min(1).max(VISION_MAX_ITEMS),
}).strict();

export const confirmRecognitionResultSchema = z.object({
  inventoryVersion: z.number().int().nonnegative(),
  items: z.array(inventoryItemSchema).min(1).max(VISION_MAX_ITEMS),
}).strict();

export type VisionResult = z.infer<typeof visionResultSchema>;
export type VisionConfirmationReason = z.infer<
  typeof visionConfirmationReasonSchema
>;
export type VisionCandidate = z.infer<typeof visionCandidateSchema>;
export type RecognitionPreview = z.infer<typeof recognitionPreviewSchema>;
export type ConfirmRecognitionItem = z.infer<
  typeof confirmRecognitionItemSchema
>;
export type ConfirmRecognitionInput = z.infer<
  typeof confirmRecognitionInputSchema
>;
export type ConfirmRecognitionResult = z.infer<
  typeof confirmRecognitionResultSchema
>;
