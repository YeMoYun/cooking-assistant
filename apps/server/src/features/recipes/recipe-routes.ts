import {
  AppError,
  favoriteRecipeQuerySchema,
  recentRecipeQuerySchema,
  recipeIdParamsSchema,
  type ApiSuccess,
  type FavoriteRecipePage,
  type RecentRecipeList,
  type RecipeDetail,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { RecipeRepository } from './recipe-repository.js';

export type RecipeRouteClock = () => Date;

const invalidParameters = (): AppError => new AppError(
  'validation_error',
  '请求参数无效',
  400,
);

export const registerRecipeRoutes = (
  app: FastifyInstance,
  database: Database.Database,
  now: RecipeRouteClock = () => new Date(),
): void => {
  const repository = new RecipeRepository(database);

  app.get('/api/recipes/:recipeId', (request): ApiSuccess<RecipeDetail> => {
    const params = recipeIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw invalidParameters();
    }
    return { data: repository.getRecipeDetail(params.data.recipeId) };
  });

  app.put('/api/favorites/:recipeId', (request) => {
    const params = recipeIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw invalidParameters();
    }
    return {
      data: repository.setFavorite(
        params.data.recipeId,
        true,
        now().toISOString(),
      ),
    };
  });

  app.delete('/api/favorites/:recipeId', (request) => {
    const params = recipeIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw invalidParameters();
    }
    return {
      data: repository.setFavorite(
        params.data.recipeId,
        false,
        now().toISOString(),
      ),
    };
  });

  app.get('/api/favorites', (request): ApiSuccess<FavoriteRecipePage> => {
    const query = favoriteRecipeQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw invalidParameters();
    }
    return {
      data: repository.listFavorites(query.data.cursor, query.data.limit),
    };
  });

  app.get('/api/recent-views', (request): ApiSuccess<RecentRecipeList> => {
    const query = recentRecipeQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw invalidParameters();
    }
    return { data: repository.listRecentViews(query.data.limit) };
  });

  app.post('/api/recent-views/:recipeId', (request) => {
    const params = recipeIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw invalidParameters();
    }
    return {
      data: repository.recordRecentView(
        params.data.recipeId,
        now().toISOString(),
      ),
    };
  });
};
