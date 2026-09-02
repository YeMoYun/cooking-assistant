import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { ProviderRepository, type SaveProviderProfile } from '../providers/provider-repository.js';
import { VoiceRepository } from './voice-repository.js';

const capabilities = {
  chat: true,
  stream: true,
  tools: true,
  json: true,
  reasoning: false,
  vision: false,
} as const;

const provider = (
  id: string,
  name: string,
  modelId: string,
): SaveProviderProfile => ({
  id,
  name,
  kind: 'text',
  template: 'qwen',
  normalizedBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  modelId,
  capabilities,
  streamEnabled: true,
  keyRef: `key-${id}`,
  enabled: true,
  lastTestedAt: null,
});

describe('VoiceRepository.changeProvider', () => {
  const roots: string[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    databases.splice(0).forEach((database) => {
      if (database.open) database.close();
    });
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-voice-'));
    const database = openDatabase(join(root, 'app.sqlite'));
    roots.push(root);
    databases.push(database);
    const providers = new ProviderRepository(database);
    const first = provider('11111111-1111-4111-8111-111111111111', '模型 A', 'qwen-plus');
    const second = provider('22222222-2222-4222-8222-222222222222', '模型 B', 'deepseek-chat');
    providers.insert(first, '2026-09-02T00:00:00.000Z');
    providers.insert(second, '2026-09-02T00:00:00.000Z');
    return { first, second, sessions: new VoiceRepository(database) };
  };

  it('changes the active model without discarding completed history', () => {
    const { first, second, sessions } = setup();
    const session = sessions.create({
      providerId: first.id,
      providerName: first.name,
      modelId: first.modelId,
      context: { includeInventory: false, includeShopping: false },
    });
    sessions.message(session.id, crypto.randomUUID(), 0, 'user', '上一轮问题');
    sessions.message(session.id, crypto.randomUUID(), 1, 'assistant', '上一轮回答');

    const updated = sessions.changeProvider(session.id, {
      providerId: second.id,
      providerName: second.name,
      modelId: second.modelId,
    });

    expect(updated).toMatchObject({
      providerId: second.id,
      providerName: second.name,
      modelId: second.modelId,
    });
    expect(sessions.history(session.id)).toEqual([
      { role: 'user', content: '上一轮问题' },
      { role: 'assistant', content: '上一轮回答' },
    ]);
  });

  it('rejects switching an ended session', () => {
    const { first, second, sessions } = setup();
    const session = sessions.create({
      providerId: first.id,
      providerName: first.name,
      modelId: first.modelId,
      context: { includeInventory: false, includeShopping: false },
    });
    sessions.end(session.id);

    expect(() => sessions.changeProvider(session.id, {
      providerId: second.id,
      providerName: second.name,
      modelId: second.modelId,
    })).toThrow('会话已经结束');
  });

  it('returns the most recent 24 completed messages in conversation order', () => {
    const { first, sessions } = setup();
    const session = sessions.create({
      providerId: first.id,
      providerName: first.name,
      modelId: first.modelId,
      context: { includeInventory: false, includeShopping: false },
    });
    for (let index = 1; index <= 26; index += 1) {
      sessions.message(
        session.id,
        crypto.randomUUID(),
        index,
        index % 2 === 0 ? 'assistant' : 'user',
        `消息 ${index}`,
      );
    }

    const history = sessions.history(session.id);

    expect(history).toHaveLength(24);
    expect(history[0]?.content).toBe('消息 3');
    expect(history.at(-1)?.content).toBe('消息 26');
  });
});
