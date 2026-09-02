// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const emptyContext = { includeInventory: false, includeShopping: false };

describe('TurnController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('rejects a streamed turn error with the server message', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: {
          speechRecognition: 'browser-detect',
          speechSynthesis: 'browser-detect',
        },
        csrfToken: 'csrf-token',
        sessionExpiresAt: '2026-09-03T00:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response([
        JSON.stringify({ type: 'turn.started', session_id: sessionId, turn_id: turnId, seq: 0 }),
        JSON.stringify({
          type: 'turn.error',
          session_id: sessionId,
          turn_id: turnId,
          seq: 1,
          error: { code: 'quota', message: '模型服务额度或余额不足' },
        }),
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(turnId);
    const { TurnController } = await import('./turn-controller.js');
    const states: string[] = [];
    const controller = new TurnController(
      sessionId,
      () => undefined,
      (state) => states.push(state),
      () => undefined,
      () => true,
    );

    await expect(controller.start('你好', emptyContext))
      .rejects.toThrow('模型服务额度或余额不足');
    expect(states.at(-1)).toBe('error');
  });
});
