import {
  AppError,
  recipeSearchQuerySchema,
  type ApiSuccess,
  type RecipePage,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { RecipeSearchRepository } from './search-repository.js';
import { RecipeSearchService } from './search-service.js';

export const registerRecipeSearchRoutes = (
  app: FastifyInstance,
  database: Database.Database,
): void => {
  const service = new RecipeSearchService(
    new RecipeSearchRepository(database),
  );

  app.get('/api/recipes', (request, reply): ApiSuccess<RecipePage> => {
    const query = recipeSearchQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new AppError('validation_error', '搜索参数无效', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return { data: service.search(query.data) };
  });
};
