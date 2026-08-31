import {
  AppError,
  createVoiceSessionInputSchema,
  pendingActionPreviewSchema,
  voiceSessionIdParamsSchema,
  voiceTurnInputSchema,
} from '@xiaochu/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { ProviderRepository } from '../providers/provider-repository.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { JsonModelClient } from '../providers/json-model-client.js';
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
import { VoiceRepository } from './voice-repository.js';

const streamError = (cancelled: boolean): { readonly code: string; readonly message: string } => (
  cancelled
    ? { code: 'cancelled', message: 'The response was interrupted.' }
    : { code: 'voice_turn_failed', message: 'The assistant is temporarily unavailable.' }
);

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
    const abortOnClose = (): void => active.abort(new Error('Client disconnected'));
    request.raw.once('aborted', abortOnClose);
    request.raw.once('close', abortOnClose);
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
    } catch {
      sessions.message(
        sessionId,
        body.turnId,
        sequence,
        'assistant',
        answer,
        active.signal.aborted ? 'cancelled' : 'error',
      );
      send({ type: 'turn.error', error: streamError(active.signal.aborted) });
    } finally {
      request.raw.off('aborted', abortOnClose);
      request.raw.off('close', abortOnClose);
      activeTurns.finish(sessionId, active);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
};
