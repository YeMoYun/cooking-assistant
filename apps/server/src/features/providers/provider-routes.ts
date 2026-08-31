import {
  AppError,
  createProviderProfileInputSchema,
  providerIdParamsSchema,
  updateProviderProfileInputSchema,
  validateProviderUrlInputSchema,
  type ApiSuccess,
  type ProviderConnectionResult,
  type ProviderProfile,
  type ProviderUrlValidation,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ROUTE_SECURITY_CONFIGS } from '../../plugins/request-security.js';
import {
  OutboundUrlPolicy,
} from './outbound-url-policy.js';
import {
  ProviderService,
  type ProviderServiceOptions,
} from './provider-service.js';
import type { SecretStore } from './secret-store.js';

export interface ProviderRouteOptions extends ProviderServiceOptions {
  readonly allowLoopbackHttp?: boolean;
}

const invalidProviderRequest = (): AppError => new AppError(
  'validation_error',
  '模型配置参数无效',
  400,
);

const requestAbortSignal = (request: FastifyRequest): AbortSignal => {
  const controller = new AbortController();
  if (request.raw.aborted) {
    controller.abort();
  } else {
    request.raw.once('aborted', () => controller.abort());
  }
  return controller.signal;
};

export const registerProviderRoutes = (
  app: FastifyInstance,
  database: Database.Database,
  secretStore: SecretStore,
  options: ProviderRouteOptions = {},
): void => {
  const urlPolicy = options.urlPolicy ?? new OutboundUrlPolicy({
    allowLoopbackHttp: options.allowLoopbackHttp ?? false,
  });
  const service = new ProviderService(database, secretStore, {
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.modelClient === undefined
      ? {}
      : { modelClient: options.modelClient }),
    ...(options.now === undefined ? {} : { now: options.now }),
    urlPolicy,
  });

  app.get('/api/providers', (): ApiSuccess<ProviderProfile[]> => ({
    data: service.list(),
  }));

  app.post('/api/providers/validate', {
    config: ROUTE_SECURITY_CONFIGS.providerTest,
  }, async (request): Promise<ApiSuccess<ProviderUrlValidation>> => {
    const body = validateProviderUrlInputSchema.safeParse(request.body);
    if (!body.success) {
      throw invalidProviderRequest();
    }
    return { data: await service.validateUrl(body.data.baseUrl) };
  });

  app.post('/api/providers', {
    config: ROUTE_SECURITY_CONFIGS.providerTest,
  }, async (request): Promise<ApiSuccess<ProviderProfile>> => {
    const body = createProviderProfileInputSchema.safeParse(request.body);
    if (!body.success) {
      throw invalidProviderRequest();
    }
    return { data: await service.create(body.data, requestAbortSignal(request)) };
  });

  app.patch('/api/providers/:providerId', {
    config: ROUTE_SECURITY_CONFIGS.providerTest,
  }, async (request): Promise<ApiSuccess<ProviderProfile>> => {
    const params = providerIdParamsSchema.safeParse(request.params);
    const body = updateProviderProfileInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      throw invalidProviderRequest();
    }
    return {
      data: await service.update(
        params.data.providerId,
        body.data,
        requestAbortSignal(request),
      ),
    };
  });

  app.delete('/api/providers/:providerId', async (request, reply) => {
    const params = providerIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw invalidProviderRequest();
    }
    await service.delete(params.data.providerId);
    return reply.status(204).send();
  });

  app.post('/api/providers/:providerId/test', {
    config: ROUTE_SECURITY_CONFIGS.providerTest,
  }, async (request): Promise<ApiSuccess<ProviderConnectionResult>> => {
    const params = providerIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw invalidProviderRequest();
    }
    return {
      data: await service.test(params.data.providerId, requestAbortSignal(request)),
    };
  });
};
