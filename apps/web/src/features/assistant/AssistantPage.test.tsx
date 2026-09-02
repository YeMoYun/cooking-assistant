// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProviderProfile } from '@xiaochu/shared';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantPage } from './AssistantPage';

const { requestMock, streamMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  streamMock: vi.fn(),
}));

vi.mock('../../lib/api-client', () => ({
  apiClient: { request: requestMock, stream: streamMock },
}));

const provider = (
  id: string,
  name: string,
  modelId: string,
): ProviderProfile => ({
  id,
  protocol: 'openai-chat-completions',
  name,
  kind: 'text',
  template: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  modelId,
  capabilities: {
    chat: true,
    stream: true,
    tools: true,
    json: true,
    reasoning: false,
    vision: false,
  },
  streamEnabled: true,
  enabled: true,
  hasKey: true,
  lastTestedAt: '2026-09-02T00:00:00.000Z',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
});

const first = provider('11111111-1111-4111-8111-111111111111', '模型 A', 'qwen-plus');
const second = provider('22222222-2222-4222-8222-222222222222', '模型 B', 'deepseek-chat');
const sessionId = '33333333-3333-4333-8333-333333333333';

describe('AssistantPage model switching', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    requestMock.mockReset();
    streamMock.mockReset();
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/api/providers') return [first, second];
      if (path === '/api/voice/sessions') return { id: sessionId };
      if (path.endsWith('/provider')) return { id: sessionId, providerId: second.id };
      return undefined;
    });
    streamMock.mockImplementation(async (_path: string, options: { body?: unknown }) => {
      const body = options.body as { turnId: string };
      return new Response([
        JSON.stringify({ type: 'turn.started', session_id: sessionId, turn_id: body.turnId, seq: 0 }),
        JSON.stringify({ type: 'text.delta', session_id: sessionId, turn_id: body.turnId, seq: 1, text: '你好，我在。' }),
        JSON.stringify({ type: 'turn.finished', session_id: sessionId, turn_id: body.turnId, seq: 2, messageId: 'message-1' }),
        '',
      ].join('\n'));
    });
  });

  it('updates the active session model without clearing the transcript', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><AssistantPage /></MemoryRouter>);
    const selector = await screen.findByRole('combobox', { name: '文本模型' });
    await user.type(screen.getByRole('textbox', { name: '烹饪问题' }), '你好');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('你好，我在。')).toBeInTheDocument();

    await user.selectOptions(selector, second.id);

    await waitFor(() => expect(requestMock).toHaveBeenCalledWith(
      `/api/voice/sessions/${sessionId}/provider`,
      expect.objectContaining({ method: 'PATCH', body: { providerId: second.id } }),
    ));
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText('你好，我在。')).toBeInTheDocument();
  });

  it('shows a streamed model error without leaving an empty assistant bubble', async () => {
    streamMock.mockImplementationOnce(async (_path: string, options: { body?: unknown }) => {
      const body = options.body as { turnId: string };
      return new Response([
        JSON.stringify({ type: 'turn.started', session_id: sessionId, turn_id: body.turnId, seq: 0 }),
        JSON.stringify({
          type: 'turn.error',
          session_id: sessionId,
          turn_id: body.turnId,
          seq: 1,
          error: { code: 'quota', message: '模型服务额度或余额不足' },
        }),
        '',
      ].join('\n'));
    });
    const user = userEvent.setup();
    render(<MemoryRouter><AssistantPage /></MemoryRouter>);
    await screen.findByRole('combobox', { name: '文本模型' });
    await user.type(screen.getByRole('textbox', { name: '烹饪问题' }), '你好');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('模型服务额度或余额不足')).toBeInTheDocument();
    expect(screen.queryByText('…')).not.toBeInTheDocument();
  });
});
