import { AppError, recipeIdParamsSchema } from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { RecipeCoverCache } from './recipe-cover-cache.js';

interface CoverRow {
  readonly cover_remote_url: string | null;
}

export const registerRecipeCoverRoutes = (
  app: FastifyInstance,
  database: Database.Database,
  cacheDirectory: string,
): void => {
  const cache = new RecipeCoverCache({ cacheDirectory });
  const findCover = database.prepare(`
    SELECT cover_remote_url
    FROM recipes
    WHERE id = ? AND is_active = 1
  `);

  app.get('/api/recipe-covers/:recipeId', async (request, reply) => {
    const params = recipeIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError('validation_error', '请求参数无效', 400);
    }
    const row = findCover.get(params.data.recipeId) as CoverRow | undefined;
    if (row?.cover_remote_url === null || row === undefined) {
      throw new AppError('recipe_cover_not_found', '食谱封面不存在', 404);
    }
    let cover;
    try {
      cover = await cache.get(params.data.recipeId, row.cover_remote_url);
    } catch {
      throw new AppError('recipe_cover_unavailable', '食谱封面暂时无法加载', 502);
    }
    reply
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Type', 'image/webp')
      .header('ETag', cover.etag)
      .header('X-Content-Type-Options', 'nosniff');
    if (request.headers['if-none-match'] === cover.etag) {
      return reply.code(304).send();
    }
    return reply.send(cover.body);
  });
};

