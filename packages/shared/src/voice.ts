import { z } from 'zod'
import { pendingActionPreviewSchema } from './pending-action.js'
export const contextSelectionSchema = z.object({ recipeId: z.string().min(1).max(100).optional(), includeInventory: z.boolean().default(false), includeShopping: z.boolean().default(false) }).strict()
export const voiceTurnInputSchema = z.object({ turnId: z.string().uuid(), text: z.string().trim().min(1).max(8000), context: contextSelectionSchema }).strict()
export const createVoiceSessionInputSchema = z.object({ providerId: z.string().uuid(), context: contextSelectionSchema.default({ includeInventory: false, includeShopping: false }) }).strict()
export const voiceSessionIdParamsSchema = z.object({ sessionId: z.string().uuid() }).strict()
export type ContextSelection = z.infer<typeof contextSelectionSchema>
export type VoiceFrame =
 | { type: 'turn.started'; session_id: string; turn_id: string; seq: number }
 | { type: 'text.delta'; session_id: string; turn_id: string; seq: number; text: string }
 | { type: 'tool.draft'; session_id: string; turn_id: string; seq: number; action: z.infer<typeof pendingActionPreviewSchema> }
 | { type: 'turn.finished'; session_id: string; turn_id: string; seq: number; messageId: string }
 | { type: 'turn.error'; session_id: string; turn_id: string; seq: number; error: { code: string; message: string } }
