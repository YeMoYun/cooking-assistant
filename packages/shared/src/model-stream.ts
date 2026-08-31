export type ModelStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_delta'; readonly index: number; readonly callId: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown' }

export interface ChatMessage { readonly role: 'system' | 'user' | 'assistant' | 'tool'; readonly content: string }
export interface ChatRequest { readonly modelId: string; readonly messages: readonly ChatMessage[]; readonly tools?: readonly unknown[] }
