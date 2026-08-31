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
    for await (const event of this.client.stream({
      profile: this.profile,
      messages,
      signal,
      jsonMode: false,
      ...(request.tools === undefined ? {} : { tools: request.tools }),
    })) {
      if (event.type === 'text') yield { type: 'text_delta', text: event.text }
      if (event.type === 'tool') yield {
        type: 'tool_delta', index: event.index, callId: event.callId,
        ...(event.name === undefined ? {} : { name: event.name }),
        ...(event.argumentsDelta === undefined ? {} : { argumentsDelta: event.argumentsDelta }),
      }
      if (event.type === 'finish') yield { type: 'finish', reason: normalizeFinishReason(event.reason) }
    }
  }
  async testConnection(signal: AbortSignal) { const result = await this.client.testConnection(this.profile, signal); return { model: result.model, capabilities: result.capabilities } }
}
