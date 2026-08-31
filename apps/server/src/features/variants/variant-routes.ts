import {
  AppError,
  confirmRecipeVariantInputSchema,
  recipeIdParamsSchema,
  recipeVariantIdParamsSchema,
  recipeVariantListQuerySchema,
  recipeVariantPreviewInputSchema,
  type ApiSuccess,
  type PendingActionPreview,
  type RecipeVariantDetail,
  type RecipeVariantPage,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ROUTE_SECURITY_CONFIGS } from '../../plugins/request-security.js';
import { readSessionIdFromCookieHeader } from '../../plugins/session.js';
import type { VariantAdapter } from './variant-adapter.js';
import { VariantService, type VariantServiceOptions } from './variant-service.js';

const invalidRequest = (): AppError => new AppError(
  'validation_error',
  'AI 改菜谱参数无效',
  400,
);

const requireSessionId = (request: FastifyRequest): string => {
  const sessionId = readSessionIdFromCookieHeader(request.headers.cookie);
  if (sessionId === undefined) {
    throw new AppError('forbidden', 'Request forbidden', 403);
  }
  return sessionId;
};

const withRequestAbortSignal = async <T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error('Client disconnected'));
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
  }
};

export const registerVariantRoutes = (
  app: FastifyInstance,
  database: Database.Database,
  adapter: VariantAdapter,
  options: VariantServiceOptions = {},
): void => {
  const service = new VariantService(database, adapter, options);

  app.post(
    '/api/recipes/:recipeId/variants/preview',
    { config: ROUTE_SECURITY_CONFIGS.modelStream },
    async (request): Promise<ApiSuccess<PendingActionPreview>> => {
      const params = recipeIdParamsSchema.safeParse(request.params);
      const body = recipeVariantPreviewInputSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw invalidRequest();
      }
      const data = await withRequestAbortSignal(request, (signal) => (
        service.preview(
          params.data.recipeId,
          body.data,
          requireSessionId(request),
          signal,
        )
      ));
      return { data };
    },
  );

  app.post(
    '/api/recipes/:recipeId/variants/confirm',
    { config: ROUTE_SECURITY_CONFIGS.confirmation },
    (request): ApiSuccess<RecipeVariantDetail> => {
      const params = recipeIdParamsSchema.safeParse(request.params);
      const body = confirmRecipeVariantInputSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw invalidRequest();
      }
      return {
        data: service.confirm(
          params.data.recipeId,
          body.data.pendingActionId,
          requireSessionId(request),
        ),
      };
    },
  );

  app.get('/api/recipe-variants', (request): ApiSuccess<RecipeVariantPage> => {
    const query = recipeVariantListQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw invalidRequest();
    }
    return {
      data: service.list(query.data.cursor, query.data.limit),
    };
  });

  app.get(
    '/api/recipe-variants/:variantId',
    (request): ApiSuccess<RecipeVariantDetail> => {
      const params = recipeVariantIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw invalidRequest();
      }
      return { data: service.get(params.data.variantId) };
    },
  );
};

