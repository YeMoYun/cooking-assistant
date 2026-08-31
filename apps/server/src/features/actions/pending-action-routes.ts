import {
  AppError,
  pendingActionConfirmationSchema,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ROUTE_SECURITY_CONFIGS } from '../../plugins/request-security.js';
import { readSessionIdFromCookieHeader } from '../../plugins/session.js';
import { RecipeRepository } from '../recipes/recipe-repository.js';
import { ShoppingService } from '../shopping/shopping-service.js';
import { PendingActionService } from './pending-action-service.js';

const notePayload = z.object({
  recipeId: z.string().min(1).max(100),
  body: z.string().trim().min(1).max(10_000),
  noteId: z.string().uuid(),
}).strict();

const sessionId = (request: FastifyRequest): string => {
  const value = readSessionIdFromCookieHeader(request.headers.cookie);
  if (value === undefined) throw new AppError('forbidden', 'Request forbidden', 403);
  return value;
};

export const registerPendingActionRoutes = (
  app: FastifyInstance,
  database: Database.Database,
): void => {
  const actions = new PendingActionService(database);
  const shopping = new ShoppingService(database);
  const recipes = new RecipeRepository(database);

  app.post('/api/pending-actions/:pendingActionId/confirm', {
    config: ROUTE_SECURITY_CONFIGS.confirmation,
  }, (request) => {
    const body = pendingActionConfirmationSchema.parse({
      pendingActionId: (request.params as { pendingActionId?: unknown }).pendingActionId,
    });
    const boundSessionId = sessionId(request);
    const action = actions.inspect(body.pendingActionId, boundSessionId);
    if (action.kind === 'shopping_items' && action.toolName === 'generate_shopping_items') {
      return { data: shopping.confirmGenerated(body.pendingActionId, boundSessionId) };
    }
    if (action.kind === 'note' && action.toolName === 'assistant.note.create') {
      const data = actions.confirm({
        pendingActionId: body.pendingActionId,
        sessionId: boundSessionId,
        toolName: action.toolName,
        parsePayload: (value) => notePayload.parse(value),
        execute: (payload) => recipes.createNote(payload, new Date().toISOString()),
      });
      return { data };
    }
    throw new AppError('pending_action_unsupported', 'Confirm this action from its original screen.', 409);
  });

  app.post('/api/pending-actions/:pendingActionId/reject', {
    config: ROUTE_SECURITY_CONFIGS.confirmation,
  }, (request) => {
    const body = pendingActionConfirmationSchema.parse({
      pendingActionId: (request.params as { pendingActionId?: unknown }).pendingActionId,
    });
    actions.reject(body.pendingActionId, sessionId(request));
    return { data: { rejected: true } };
  });
};
