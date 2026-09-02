import {
  AppError,
  changeVoiceSessionProviderInputSchema,
  createVoiceSessionInputSchema,
  pendingActionPreviewSchema,
  voiceSessionIdParamsSchema,
  voiceTurnInputSchema,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { ProviderRepository } from '../providers/provider-repository.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { JsonModelClient, ModelClientError } from '../providers/json-model-client.js';
import type { SecretStore } from '../providers/secret-store.js';
import { createDraftNoteTool } from '../tools/draft-note-tool.js';
import { createDraftShoppingItemsTool } from '../tools/draft-shopping-items-tool.js';
import { createReadInventoryTool } from '../tools/read-inventory-tool.js';
import { createSearchRecipesTool } from '../tools/search-recipes-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ROUTE_SECURITY_CONFIGS } from '../../plugins/request-security.js';
import { ActiveTurns } from './active-turns.js';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { buildAuthorizedContext } from './context-builder.js';
import { bindStreamCancellation } from './stream-lifecycle.js';
import { VoiceRepository } from './voice-repository.js';

const modelErrorMessages = {
  auth: '鉴权失败，请重新输入 API Key',
  model_not_found: '当前 Model ID 不存在',
  quota: '模型服务额度或余额不足',
  rate_limited: '模型服务请求过于频繁，请稍后重试',
  timeout: '模型服务连接超时',
  protocol: '模型服务返回了不兼容的协议内容',
  upstream: '模型服务暂时不可用',
  cancelled: '模型服务请求已取消',
  unknown: '模型服务连接失败',
} as const;

const streamError = (
  error: unknown,
  cancelled: boolean,
): { readonly code: string; readonly message: string } => {
  if (cancelled) return { code: 'cancelled', message: '回复已被中断' };
  if (error instanceof ModelClientError) {
    return { code: error.code, message: modelErrorMessages[error.code] };
  }
  return { code: 'voice_turn_failed', message: '智能助手暂时不可用，请稍后重试' };
};

export const registerVoiceRoutes = (
  app: FastifyInstance,
  database: Database.Database,
  secrets: SecretStore,
): void => {
  const sessions = new VoiceRepository(database);
  const providers = new ProviderRepository(database);
  const registry = new ProviderRegistry(providers, new JsonModelClient(secrets));
  const tools = new ToolRegistry([
    createSearchRecipesTool(database),
    createReadInventoryTool(database),
    createDraftShoppingItemsTool(database),
    createDraftNoteTool(database),
  ]);
  const orchestrator = new AgentOrchestrator(tools);
  const activeTurns = new ActiveTurns();

  app.post('/api/voice/sessions', {
    config: ROUTE_SECURITY_CONFIGS.modelStream,
  }, (request) => {
    const body = createVoiceSessionInputSchema.parse(request.body);
    const profile = providers.get(body.providerId);
    if (profile === undefined || !profile.enabled || profile.kind !== 'text') {
      throw new AppError('provider_unavailable', 'Choose an enabled text model.', 409);
    }
    return {
      data: sessions.create({
        providerId: profile.id,
        providerName: profile.name,
        modelId: profile.modelId,
        context: body.context,
      }),
    };
  });

  app.get('/api/voice/sessions', () => ({ data: sessions.list() }));
  app.get('/api/voice/sessions/:sessionId', (request) => ({
    data: sessions.get(voiceSessionIdParamsSchema.parse(request.params).sessionId),
  }));
  app.post('/api/voice/sessions/:sessionId/end', {
    config: ROUTE_SECURITY_CONFIGS.confirmation,
  }, (request) => {
    sessions.end(voiceSessionIdParamsSchema.parse(request.params).sessionId);
    return { data: { ended: true } };
  });

  app.patch('/api/voice/sessions/:sessionId/provider', {
    config: ROUTE_SECURITY_CONFIGS.confirmation,
  }, (request) => {
    const sessionId = voiceSessionIdParamsSchema.parse(request.params).sessionId;
    const body = changeVoiceSessionProviderInputSchema.parse(request.body);
    const profile = providers.get(body.providerId);
    if (profile === undefined || !profile.enabled || profile.kind !== 'text') {
      throw new AppError('provider_unavailable', '请选择一个已启用的文本模型', 409);
    }
    return {
      data: sessions.changeProvider(sessionId, {
        providerId: profile.id,
        providerName: profile.name,
        modelId: profile.modelId,
      }),
    };
  });

  app.post('/api/voice/sessions/:sessionId/turns', {
    config: ROUTE_SECURITY_CONFIGS.modelStream,
  }, async (request, reply) => {
    const sessionId = voiceSessionIdParamsSchema.parse(request.params).sessionId;
    const body = voiceTurnInputSchema.parse(request.body);
    const session = sessions.get(sessionId);
    if (session.status !== 'active' || session.providerId === null) {
      throw new AppError('voice_session_ended', 'The conversation has ended.', 409);
    }
    const active = activeTurns.begin(sessionId);
    const removeCancellationListeners = bindStreamCancellation(
      request.raw,
      reply.raw,
      active,
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    let sequence = 0;
    const send = (frame: Record<string, unknown>): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`${JSON.stringify({ ...frame, session_id: sessionId, turn_id: body.turnId, seq: sequence++ })}\n`);
      }
    };

    const history = sessions.history(sessionId);
    send({ type: 'turn.started' });
    sessions.message(sessionId, body.turnId, 0, 'user', body.text);
    let answer = '';
    try {
      const provider = registry.get(session.providerId);
      const context = buildAuthorizedContext(database, body.context);
      for await (const event of orchestrator.run({
        adapter: provider.adapter,
        context,
        selection: body.context,
        sessionId,
        modelId: session.modelId,
        history,
        text: body.text,
        providerSupportsTools: provider.profile.capabilities.tools,
      }, active.signal)) {
        if (event.type === 'text') {
          answer += event.text;
          send({ type: 'text.delta', text: event.text });
        } else {
          send({ type: 'tool.draft', action: pendingActionPreviewSchema.parse(event.action) });
        }
      }
      const messageId = sessions.message(sessionId, body.turnId, sequence, 'assistant', answer);
      send({ type: 'turn.finished', messageId });
    } catch (error) {
      sessions.message(
        sessionId,
        body.turnId,
        sequence,
        'assistant',
        answer,
        active.signal.aborted ? 'cancelled' : 'error',
      );
      send({ type: 'turn.error', error: streamError(error, active.signal.aborted) });
    } finally {
      removeCancellationListeners();
      activeTurns.finish(sessionId, active);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
};
