import {
  AppError,
  addShoppingItemToInventorySchema,
  createShoppingItemSchema,
  deleteVersionQuerySchema,
  generateShoppingPreviewSchema,
  pendingActionConfirmationSchema,
  updateShoppingItemSchema,
  versionedItemParamsSchema,
  type ApiSuccess,
  type InventoryItem,
  type PendingActionPreview,
  type ShoppingItem,
  type ShoppingSnapshot,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ROUTE_SECURITY_CONFIGS } from '../../plugins/request-security.js';
import { readSessionIdFromCookieHeader } from '../../plugins/session.js';
import { ShoppingService } from './shopping-service.js';

const invalidRequest = (): AppError => new AppError(
  'validation_error',
  '购物清单参数无效',
  400,
);

const requireSessionId = (request: FastifyRequest): string => {
  const cookieHeader = request.headers.cookie;
  const sessionId = readSessionIdFromCookieHeader(cookieHeader);
  if (sessionId === undefined) {
    throw new AppError('forbidden', 'Request forbidden', 403);
  }
  return sessionId;
};

export const registerShoppingRoutes = (
  app: FastifyInstance,
  database: Database.Database,
): void => {
  const service = new ShoppingService(database);

  app.get('/api/shopping', (): ApiSuccess<ShoppingSnapshot> => ({
    data: service.getSnapshot(),
  }));

  app.post('/api/shopping', (request): ApiSuccess<ShoppingItem> => {
    const body = createShoppingItemSchema.safeParse(request.body);
    if (!body.success) {
      throw invalidRequest();
    }
    return { data: service.create(body.data) };
  });

  app.patch('/api/shopping/:itemId', (request): ApiSuccess<ShoppingItem> => {
    const params = versionedItemParamsSchema.safeParse(request.params);
    const body = updateShoppingItemSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      throw invalidRequest();
    }
    return { data: service.update(params.data.itemId, body.data) };
  });

  app.delete('/api/shopping/:itemId', (request, reply) => {
    const params = versionedItemParamsSchema.safeParse(request.params);
    const query = deleteVersionQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      throw invalidRequest();
    }
    service.delete(params.data.itemId, query.data.version);
    return reply.status(204).send();
  });

  app.post(
    '/api/shopping/generate-preview',
    (request): ApiSuccess<PendingActionPreview> => {
      const body = generateShoppingPreviewSchema.safeParse(request.body);
      if (!body.success) {
        throw invalidRequest();
      }
      return {
        data: service.generatePreview(body.data, requireSessionId(request)),
      };
    },
  );

  app.post(
    '/api/shopping/generate-confirm',
    { config: ROUTE_SECURITY_CONFIGS.confirmation },
    (request): ApiSuccess<ShoppingSnapshot> => {
      const body = pendingActionConfirmationSchema.safeParse(request.body);
      if (!body.success) {
        throw invalidRequest();
      }
      return {
        data: service.confirmGenerated(
          body.data.pendingActionId,
          requireSessionId(request),
        ),
      };
    },
  );

  app.post(
    '/api/shopping/:itemId/add-to-inventory',
    (request): ApiSuccess<InventoryItem> => {
      const params = versionedItemParamsSchema.safeParse(request.params);
      const body = addShoppingItemToInventorySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw invalidRequest();
      }
      return {
        data: service.addCheckedItemToInventory(
          params.data.itemId,
          body.data.inventoryItemId,
        ),
      };
    },
  );
};
