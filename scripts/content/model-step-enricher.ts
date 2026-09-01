import Database from 'better-sqlite3';
import { z } from 'zod';
import { resolveAppPaths } from '../../apps/server/src/config.js';
import { DpapiSecretStore } from '../../apps/server/src/features/providers/dpapi-secret-store.js';
import { JsonModelClient } from '../../apps/server/src/features/providers/json-model-client.js';
import { ProviderRepository } from '../../apps/server/src/features/providers/provider-repository.js';
import {
  stepHasRecognizedAction,
  type EnrichedStep,
  type StepEnrichmentInput,
} from './step-enricher.js';

const modelStepSchema = z.object({
  instruction: z.string().min(8).max(2_000),
  durationSecondsMin: z.number().int().min(10).max(28_800),
  durationSecondsMax: z.number().int().min(10).max(28_800),
  heatOrDevice: z.string().min(2).max(200),
  completionCue: z.string().min(4).max(500),
  commonMistake: z.string().min(4).max(500),
  safetyRequirement: z.string().min(4).max(500),
}).strict().refine(
  (step) => step.durationSecondsMin <= step.durationSecondsMax,
  { path: ['durationSecondsMax'], message: 'Invalid duration range' },
);

export interface ModelStepEnricher {
  enrich(input: StepEnrichmentInput, fallback: EnrichedStep): Promise<EnrichedStep>;
  close(): void;
}

const visibleCharacters = (value: string): string => value
  .normalize('NFKC')
  .replace(/[\p{P}\p{S}\s]/gu, '');

export const needsModelEnrichment = (
  input: StepEnrichmentInput,
  fallback: EnrichedStep,
): boolean => (
  visibleCharacters(input.instruction).length < 4
  || (!stepHasRecognizedAction(input.instruction) && fallback.ingredientNames.length === 0)
);

const parseJsonText = (value: string): unknown => {
  const cleaned = value.trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
  return JSON.parse(cleaned);
};

export const createConfiguredModelStepEnricher = async (
  providerId: string | undefined,
): Promise<ModelStepEnricher | undefined> => {
  if (providerId === undefined || providerId.trim() === '') return undefined;

  const paths = resolveAppPaths();
  const database = new Database(paths.databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  const profile = new ProviderRepository(database).get(providerId);
  if (profile === undefined || !profile.enabled || !profile.capabilities.chat) {
    database.close();
    throw new Error(`Configured text provider is unavailable: ${providerId}`);
  }

  const secretStore = await DpapiSecretStore.create();
  const client = new JsonModelClient(secretStore);

  return {
    enrich: async (input, fallback) => {
      if (!needsModelEnrichment(input, fallback)) return fallback;
      const ingredientList = input.ingredients.map((ingredient) => ingredient.canonicalName).join('、');
      const messages = [
        {
          role: 'system' as const,
          content: [
            '你是中文家常菜步骤校订器，只返回一个 JSON 对象。',
            '不得增加未列出的食材，不得改变步骤顺序，不得臆造特殊设备。',
            '加热步骤必须写明火候或温度、时间范围和肉眼可判断的完成标准。',
            '洗切、腌制、静置和装盘步骤不得伪造火候，但要给出合理耗时。',
          ].join(''),
        },
        {
          role: 'user' as const,
          content: JSON.stringify({
            currentInstruction: input.instruction,
            previousInstruction: input.previousInstruction ?? null,
            nextInstruction: input.nextInstruction ?? null,
            declaredIngredients: ingredientList,
            requiredFields: [
              'instruction', 'durationSecondsMin', 'durationSecondsMax',
              'heatOrDevice', 'completionCue', 'commonMistake', 'safetyRequirement',
            ],
          }),
        },
      ];
      const controller = new AbortController();
      const result = profile.capabilities.json
        ? (await client.completeJson({
            profile,
            messages,
            signal: controller.signal,
            maxTokens: 900,
            temperature: 0.1,
            parse: (value) => modelStepSchema.parse(value),
          })).value
        : modelStepSchema.parse(parseJsonText((await client.complete({
            profile,
            messages,
            signal: controller.signal,
            maxTokens: 900,
            temperature: 0.1,
          })).content));

      return {
        ...result,
        number: fallback.number,
        ingredientNames: fallback.ingredientNames,
      };
    },
    close: () => database.close(),
  };
};
