import type { ChatRequest, ModelStreamEvent } from '@xiaochu/shared'
import type { StoredProviderProfile } from './provider-repository.js'
import { JsonModelClient, type JsonModelMessage } from './json-model-client.js'
import { normalizeFinishReason } from './provider-error.js'
import type { ProviderAdapter } from './provider-adapter.js'

/** Normalizes provider chunks; reasoning-only deltas are intentionally discarded. */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  constructor(private readonly profile: StoredProviderProfile, private readonly client: JsonModelClient) {}
  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const messages: readonly JsonModelMessage[] = request.messages.map((message): JsonModelMessage => {
      if (message.role === 'tool') return { role: 'user', content: `Tool result:\n${message.content}` }
      return { role: message.role, content: message.content }
    })
    const result = await this.client.complete({ profile: this.profile, messages, signal, jsonMode: false })
    if (result.content) yield { type: 'text_delta', text: result.content }
    yield { type: 'finish', reason: normalizeFinishReason('stop') }
  }
  async testConnection(signal: AbortSignal) { const result = await this.client.testConnection(this.profile, signal); return { model: result.model, capabilities: result.capabilities } }
}
