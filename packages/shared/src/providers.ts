import { z } from 'zod';

export const providerKindSchema = z.enum(['text', 'vision']);
export const providerTemplateSchema = z.enum(['deepseek', 'qwen', 'custom']);
export const providerProtocolSchema = z.literal('openai-chat-completions');

export const providerCapabilitiesSchema = z.object({
  chat: z.literal(true),
  stream: z.boolean(),
  tools: z.boolean(),
  json: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
}).strict();

const profileNameSchema = z.string().trim().min(1).max(100);
const baseUrlSchema = z.string().trim().min(1).max(2_048);
const modelIdSchema = z.string().trim().min(1).max(200);
const apiKeySchema = z.string().min(1).max(65_536);
const timestampSchema = z.string().datetime({ offset: true });

const editableProfileShape = {
  name: profileNameSchema,
  kind: providerKindSchema,
  template: providerTemplateSchema,
  baseUrl: baseUrlSchema,
  modelId: modelIdSchema,
  capabilities: providerCapabilitiesSchema,
  streamEnabled: z.boolean(),
  enabled: z.boolean(),
} as const;

const enforceProfileCapabilities = (
  value: {
    readonly kind: z.infer<typeof providerKindSchema>;
    readonly template: z.infer<typeof providerTemplateSchema>;
    readonly capabilities: z.infer<typeof providerCapabilitiesSchema>;
    readonly streamEnabled: boolean;
  },
  context: z.RefinementCtx,
): void => {
  if (value.streamEnabled && !value.capabilities.stream) {
    context.addIssue({
      code: 'custom',
      path: ['streamEnabled'],
      message: 'Streaming cannot be enabled for a non-streaming provider',
    });
  }
  if (value.kind === 'vision' && !value.capabilities.vision) {
    context.addIssue({
      code: 'custom',
      path: ['capabilities', 'vision'],
      message: 'Vision profiles must declare vision support',
    });
  }
  if (value.kind === 'text' && value.capabilities.vision) {
    context.addIssue({
      code: 'custom',
      path: ['capabilities', 'vision'],
      message: 'Vision capability requires a vision profile',
    });
  }
  if (value.template === 'deepseek' && value.kind !== 'text') {
    context.addIssue({
      code: 'custom',
      path: ['template'],
      message: 'The DeepSeek template is text-only',
    });
  }
};

export const createProviderProfileInputSchema = z.object({
  ...editableProfileShape,
  apiKey: apiKeySchema,
}).strict().superRefine(enforceProfileCapabilities);

export const updateProviderProfileInputSchema = z.object({
  name: editableProfileShape.name.optional(),
  kind: editableProfileShape.kind.optional(),
  template: editableProfileShape.template.optional(),
  baseUrl: editableProfileShape.baseUrl.optional(),
  modelId: editableProfileShape.modelId.optional(),
  capabilities: editableProfileShape.capabilities.optional(),
  streamEnabled: editableProfileShape.streamEnabled.optional(),
  enabled: editableProfileShape.enabled.optional(),
  apiKey: apiKeySchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be updated',
});

export const providerProfileSchema = z.object({
  id: z.string().uuid(),
  protocol: providerProtocolSchema,
  ...editableProfileShape,
  hasKey: z.boolean(),
  lastTestedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine(enforceProfileCapabilities);

export const providerProfileListSchema = z.array(providerProfileSchema);

export const providerIdParamsSchema = z.object({
  providerId: z.string().uuid(),
}).strict();

export const validateProviderUrlInputSchema = z.object({
  baseUrl: baseUrlSchema,
}).strict();

export const providerUrlValidationSchema = z.object({
  normalizedBaseUrl: baseUrlSchema,
  origin: baseUrlSchema,
  developmentLoopback: z.boolean(),
}).strict();

export const providerConnectionResultSchema = z.object({
  status: z.literal('ok'),
  model: modelIdSchema,
  capabilities: providerCapabilitiesSchema,
  testedAt: timestampSchema,
}).strict();

export const modelErrorCodeSchema = z.enum([
  'auth',
  'model_not_found',
  'quota',
  'rate_limited',
  'timeout',
  'protocol',
  'upstream',
  'cancelled',
  'unknown',
]);

export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ProviderTemplate = z.infer<typeof providerTemplateSchema>;
export type ProviderCapabilities = z.infer<
  typeof providerCapabilitiesSchema
>;
export type CreateProviderProfileInput = z.infer<
  typeof createProviderProfileInputSchema
>;
export type UpdateProviderProfileInput = z.infer<
  typeof updateProviderProfileInputSchema
>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type ProviderUrlValidation = z.infer<
  typeof providerUrlValidationSchema
>;
export type ProviderConnectionResult = z.infer<
  typeof providerConnectionResultSchema
>;
export type ModelErrorCode = z.infer<typeof modelErrorCodeSchema>;
