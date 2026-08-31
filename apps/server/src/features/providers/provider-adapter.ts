import type { ChatRequest, ModelStreamEvent, ProviderCapabilities } from '@xiaochu/shared'
export interface ProviderAdapter { streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>; testConnection(signal: AbortSignal): Promise<{ model: string; capabilities: ProviderCapabilities }> }
