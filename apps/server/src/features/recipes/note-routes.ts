import {
  AppError,
  createRecipeNoteInputSchema,
  recipeNoteIdParamsSchema,
  updateRecipeNoteInputSchema,
  type ApiSuccess,
  type RecipeNote,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  RecipeRepository,
} from './recipe-repository.js';
import type { RecipeRouteClock } from './recipe-routes.js';

const invalidNoteRequest = (): AppError => new AppError(
  'validation_error',
  '笔记参数无效',
  400,
);

export const registerRecipeNoteRoutes = (
  app: FastifyInstance,
  database: Database.Database,
  now: RecipeRouteClock = () => new Date(),
): void => {
  const repository = new RecipeRepository(database);

  app.post('/api/notes', (request): ApiSuccess<RecipeNote> => {
    const body = createRecipeNoteInputSchema.safeParse(request.body);
    if (!body.success) {
      throw invalidNoteRequest();
    }
    return {
      data: repository.createNote(body.data, now().toISOString()),
    };
  });

  app.patch('/api/notes/:noteId', (request): ApiSuccess<RecipeNote> => {
    const params = recipeNoteIdParamsSchema.safeParse(request.params);
    const body = updateRecipeNoteInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      throw invalidNoteRequest();
    }
    return {
      data: repository.updateNote(
        params.data.noteId,
        body.data.body,
        now().toISOString(),
      ),
    };
  });

  app.delete('/api/notes/:noteId', (request, reply) => {
    const params = recipeNoteIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw invalidNoteRequest();
    }
    repository.deleteNote(params.data.noteId);
    return reply.status(204).send();
  });
};
