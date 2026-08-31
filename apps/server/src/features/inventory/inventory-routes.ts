import {
  AppError,
  createInventoryItemSchema,
  deleteVersionQuerySchema,
  recipeMatchQuerySchema,
  updateInventoryItemSchema,
  versionedItemParamsSchema,
  type ApiSuccess,
  type InventoryItem,
  type InventorySnapshot,
  type RecipeMatchPage,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { InventoryRepository } from './inventory-repository.js';

const invalidRequest = (): AppError => new AppError(
  'validation_error',
  '库存参数无效',
  400,
);

export const registerInventoryRoutes = (
  app: FastifyInstance,
  database: Database.Database,
  now: () => Date = () => new Date(),
): void => {
  const repository = new InventoryRepository(database);

  app.get('/api/inventory', (): ApiSuccess<InventorySnapshot> => ({
    data: repository.getSnapshot(),
  }));

  app.post('/api/inventory', (request): ApiSuccess<InventoryItem> => {
    const body = createInventoryItemSchema.safeParse(request.body);
    if (!body.success) {
      throw invalidRequest();
    }
    return { data: repository.create(body.data, now().toISOString()) };
  });

  app.patch('/api/inventory/:itemId', (request): ApiSuccess<InventoryItem> => {
    const params = versionedItemParamsSchema.safeParse(request.params);
    const body = updateInventoryItemSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      throw invalidRequest();
    }
    return {
      data: repository.update(
        params.data.itemId,
        body.data,
        now().toISOString(),
      ),
    };
  });

  app.delete('/api/inventory/:itemId', (request, reply) => {
    const params = versionedItemParamsSchema.safeParse(request.params);
    const query = deleteVersionQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      throw invalidRequest();
    }
    repository.delete(params.data.itemId, query.data.version);
    return reply.status(204).send();
  });

  app.get(
    '/api/inventory/recipe-matches',
    (request): ApiSuccess<RecipeMatchPage> => {
      const query = recipeMatchQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw invalidRequest();
      }
      return {
        data: repository.findRecipeMatches({
          mode: query.data.mode,
          ...(query.data.cursor === undefined
            ? {}
            : { cursor: query.data.cursor }),
          limit: query.data.limit,
        }),
      };
    },
  );
};
