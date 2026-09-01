import { AppError } from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROUTE_SECURITY_CONFIGS } from '../../plugins/request-security.js';
import type { MemorySessionStore } from '../../plugins/session.js';
import type { SecretStore } from '../providers/secret-store.js';
import { clearLocalData } from './clear-local-data.js';

const clearInput = z.object({
  confirmation: z.literal('CLEAR LOCAL DATA'),
}).strict();

export interface PrivacyRouteOptions {
  readonly database: Database.Database;
  readonly secretStore: SecretStore;
  readonly sessions: MemorySessionStore;
  readonly temporaryDirectories: readonly string[];
}

export const registerPrivacyRoutes = (app: FastifyInstance, options: PrivacyRouteOptions): void => {
  app.post('/api/privacy/clear-all', {
    config: ROUTE_SECURITY_CONFIGS.confirmation,
  }, async (request) => {
    if (!clearInput.safeParse(request.body).success) {
      throw new AppError('validation_error', 'Enter the confirmation phrase exactly.', 400);
    }
    await clearLocalData({
      database: options.database,
      secretStore: options.secretStore,
      temporaryDirectories: options.temporaryDirectories,
      invalidateSessions: () => options.sessions.clear(),
    });
    return { data: { cleared: true } };
  });
};
