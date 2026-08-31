import { randomUUID as nodeRandomUUID } from 'node:crypto';
import {
  AppError,
  pendingActionPreviewSchema,
  recipeVariantDiffSchema,
  recipeVariantPreviewInputSchema,
  recipeVariantSchema,
  type PendingActionPreview,
  type RecipeVariantDetail,
  type RecipeVariantPage,
  type RecipeVariantPreviewInput,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../actions/canonical-json.js';
import { PendingActionService } from '../actions/pending-action-service.js';
import { ModelClientError } from '../providers/json-model-client.js';
import {
  findUnsafeRecipeRequestIssues,
  type FoodSafetyIssue,
} from './food-safety-rules.js';
import type { VariantAdapter } from './variant-adapter.js';
import { diffRecipeVariant } from './variant-diff.js';
import { VariantRepository } from './variant-repository.js';
import {
  RECIPE_VARIANT_VALIDATOR_VERSION,
  RecipeVariantValidationError,
  validateRecipeVariant,
} from './variant-validator.js';

const VARIANT_TOOL_NAME = 'recipe_variant.create';
const MAX_STORED_REQUEST_CHARACTERS = 100_000;
const MAX_STORED_RESULT_CHARACTERS = 500_000;

export interface VariantServiceOptions {
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

const invalidGeneratedVariant = (): AppError => new AppError(
  'variant_generation_failed',
  '修改未生成',
  422,
);

const safetyConflict = (issues: readonly FoodSafetyIssue[]): AppError => (
  new AppError(
    'unsafe_recipe_request',
    '修改要求与食品安全规则冲突，无法生成',
    422,
    {
      conflicts: issues.map((issue) => ({
        category: issue.category,
        minimumCelsius: issue.minimumCelsius,
      })),
    },
  )
);

const assertSafeRequest = (request: RecipeVariantPreviewInput): void => {
  const issues = findUnsafeRecipeRequestIssues(request);
  if (issues.length > 0) {
    throw safetyConflict(issues);
  }
};

const mapModelError = (error: ModelClientError): AppError => {
  switch (error.code) {
    case 'auth':
      return new AppError(
        'provider_auth_failed',
        '模型密钥无效，请检查模型配置',
        502,
      );
    case 'model_not_found':
      return new AppError(
        'provider_model_not_found',
        '模型不存在，请检查 Model ID',
        502,
      );
    case 'quota':
      return new AppError(
        'provider_quota_unavailable',
        '模型额度不可用，请检查账户余额或配额',
        503,
      );
    case 'rate_limited':
      return new AppError(
        'provider_rate_limited',
        '模型请求过于频繁，请稍后重试',
        503,
      );
    case 'timeout':
      return new AppError(
        'provider_timeout',
        '模型响应超时，请重试',
        504,
      );
    case 'cancelled':
      return new AppError('request_cancelled', '请求已取消', 408);
    case 'protocol':
      return invalidGeneratedVariant();
    case 'upstream':
    case 'unknown':
      return new AppError(
        'provider_unavailable',
        '模型服务暂时不可用，请稍后重试',
        502,
      );
  }
};

const pendingPayloadSchema = recipeVariantPreviewInputSchema.transform(
  (request) => request,
);

const parsePendingPayload = (value: unknown) => {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 7
    || !('sourceRecipeId' in value)
    || typeof value.sourceRecipeId !== 'string'
    || value.sourceRecipeId.length < 1
    || value.sourceRecipeId.length > 100
    || !('sourceContentVersion' in value)
    || typeof value.sourceContentVersion !== 'string'
    || value.sourceContentVersion.length < 1
    || value.sourceContentVersion.length > 50
    || !('sourceContentHash' in value)
    || typeof value.sourceContentHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.sourceContentHash)
    || !('validatorVersion' in value)
    || value.validatorVersion !== RECIPE_VARIANT_VALIDATOR_VERSION
    || !('request' in value)
    || !('result' in value)
    || !('diff' in value)
  ) {
    throw new AppError(
      'pending_action_mismatch',
      '待确认的食谱版本无效，请重新生成',
      409,
    );
  }
  return {
    sourceRecipeId: value.sourceRecipeId,
    sourceContentVersion: value.sourceContentVersion,
    sourceContentHash: value.sourceContentHash,
    request: pendingPayloadSchema.parse(value.request),
    result: recipeVariantSchema.parse(value.result),
    diff: recipeVariantDiffSchema.parse(value.diff),
    validatorVersion: RECIPE_VARIANT_VALIDATOR_VERSION,
  };
};

export class VariantService {
  readonly #now: () => number;
  readonly #pendingActions: PendingActionService;
  readonly #randomUUID: () => string;
  readonly #repository: VariantRepository;

  constructor(
    database: Database.Database,
    private readonly adapter: VariantAdapter,
    options: VariantServiceOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.#repository = new VariantRepository(database);
    this.#pendingActions = new PendingActionService(database, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async preview(
    recipeId: string,
    request: RecipeVariantPreviewInput,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PendingActionPreview> {
    assertSafeRequest(request);
    const context = this.#repository.loadPreviewContext(
      recipeId,
      request.inventoryItemIds,
    );

    let generated: unknown;
    try {
      generated = await this.adapter.generate({
        sourceRecipe: context.sourceRecipe,
        request,
        inventoryItems: context.inventoryItems,
        signal,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (error instanceof ModelClientError) {
        throw mapModelError(error);
      }
      throw error;
    }

    let validated;
    try {
      validated = validateRecipeVariant(generated, context.sourceRecipe);
    } catch (error) {
      if (error instanceof RecipeVariantValidationError) {
        throw invalidGeneratedVariant();
      }
      throw error;
    }
    if (
      canonicalJson(request).length > MAX_STORED_REQUEST_CHARACTERS
      || canonicalJson(validated.recipe).length > MAX_STORED_RESULT_CHARACTERS
    ) {
      throw invalidGeneratedVariant();
    }

    const diff = diffRecipeVariant(
      context.sourceRecipe,
      validated.recipe,
      validated.safetyWarnings,
    );
    const payload = {
      sourceRecipeId: context.sourceRecipe.id,
      sourceContentVersion: context.sourceRecipe.contentVersion,
      sourceContentHash: context.sourceRecipe.contentHash,
      request,
      result: validated.recipe,
      diff,
      validatorVersion: RECIPE_VARIANT_VALIDATOR_VERSION,
    };
    const issued = this.#pendingActions.issue({
      kind: 'recipe_variant',
      toolName: VARIANT_TOOL_NAME,
      sessionId,
      arguments: { recipeId, request },
      payload,
      expectedDataVersions: context.dataVersions,
      primaryVersionScope: 'variants',
    });

    return pendingActionPreviewSchema.parse({
      ...issued,
      title: 'AI 改菜谱预览',
      kind: 'recipe_variant',
      preview: diff,
    });
  }

  confirm(
    recipeId: string,
    pendingActionId: string,
    sessionId: string,
  ): RecipeVariantDetail {
    return this.#pendingActions.confirm({
      pendingActionId,
      sessionId,
      toolName: VARIANT_TOOL_NAME,
      parsePayload: (value) => {
        try {
          const payload = parsePendingPayload(value);
          if (payload.sourceRecipeId !== recipeId) {
            throw new AppError('forbidden', 'Request forbidden', 403);
          }
          return payload;
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          throw new AppError(
            'pending_action_mismatch',
            '待确认的食谱版本无效，请重新生成',
            409,
          );
        }
      },
      execute: (payload) => {
        assertSafeRequest(payload.request);
        this.#repository.assertSourceRecipeVersion(
          payload.sourceRecipeId,
          payload.sourceContentVersion,
          payload.sourceContentHash,
        );
        const sourceRecipe = this.#repository.getActiveSourceRecipe(
          payload.sourceRecipeId,
        );
        let validated;
        try {
          validated = validateRecipeVariant(payload.result, sourceRecipe);
        } catch (error) {
          if (error instanceof RecipeVariantValidationError) {
            throw new AppError(
              'pending_action_mismatch',
              '待确认的食谱版本未通过安全校验，请重新生成',
              409,
            );
          }
          throw error;
        }
        return this.#repository.insert({
          id: this.#randomUUID(),
          sourceRecipeId: payload.sourceRecipeId,
          request: payload.request,
          result: validated.recipe,
          validatorVersion: RECIPE_VARIANT_VALIDATOR_VERSION,
          createdAt: new Date(this.#now()).toISOString(),
        });
      },
    });
  }

  list(cursor: string | undefined, limit: number): RecipeVariantPage {
    return this.#repository.list(cursor, limit);
  }

  get(variantId: string): RecipeVariantDetail {
    return this.#repository.get(variantId);
  }
}

