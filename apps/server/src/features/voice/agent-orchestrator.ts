import type { ChatMessage, ModelStreamEvent } from '@xiaochu/shared';
import type { ProviderAdapter } from '../providers/provider-adapter.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ContextSelection } from '@xiaochu/shared';
import { NOVICE_COOK_SYSTEM_PROMPT } from './system-prompt.js';

const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_BYTES = 24_000;

export type AgentEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'draft'; readonly action: unknown };

const boundedJson = (value: unknown): string => {
  const result = JSON.stringify(value);
  return result.length <= MAX_TOOL_RESULT_BYTES ? result : result.slice(0, MAX_TOOL_RESULT_BYTES);
};

interface ToolCallBuffer {
  readonly callId: string;
  name?: string;
  argumentsJson: string;
}

export interface AgentOrchestratorInput {
  readonly adapter: ProviderAdapter;
  readonly context: string;
  readonly selection: ContextSelection;
  readonly sessionId: string;
  readonly modelId: string;
  readonly history: readonly ChatMessage[];
  readonly text: string;
  readonly providerSupportsTools: boolean;
}

export class AgentOrchestrator {
  constructor(private readonly tools: ToolRegistry) {}

  async *run(input: AgentOrchestratorInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const allowed = this.tools.allowed(input.selection, input.providerSupportsTools);
    const messages: ChatMessage[] = [
      { role: 'system', content: NOVICE_COOK_SYSTEM_PROMPT },
      { role: 'system', content: `已授权上下文：${input.context}` },
      ...input.history.slice(-24),
      { role: 'user', content: input.text },
    ];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const calls = new Map<number, ToolCallBuffer>();
      let requestedTools = false;
      for await (const event of input.adapter.streamChat({
        modelId: input.modelId,
        messages,
        ...(allowed.length === 0 ? {} : { tools: allowed.map((tool) => tool.definition) }),
      }, signal)) {
        if (event.type === 'text_delta') {
          yield { type: 'text', text: event.text };
        } else if (event.type === 'tool_delta') {
          requestedTools = true;
          const current = calls.get(event.index) ?? {
            callId: event.callId,
            argumentsJson: '',
          };
          if (event.name !== undefined) current.name = event.name;
          if (event.argumentsDelta !== undefined) current.argumentsJson += event.argumentsDelta;
          calls.set(event.index, current);
        }
      }
      if (!requestedTools) return;
      if (round === MAX_TOOL_ROUNDS) throw new Error('Tool round limit reached');

      for (const call of calls.values()) {
        const tool = call.name === undefined
          ? undefined
          : this.tools.get(call.name, input.selection, input.providerSupportsTools);
        if (tool === undefined) {
          messages.push({ role: 'tool', content: 'Tool unavailable.' });
          continue;
        }
        try {
          const argumentsValue: unknown = JSON.parse(call.argumentsJson);
          const result = await tool.execute(tool.input.parse(argumentsValue), input.sessionId);
          if (tool.permission === 'draft') yield { type: 'draft', action: result };
          messages.push({ role: 'tool', content: boundedJson(result) });
        } catch {
          messages.push({ role: 'tool', content: 'Tool could not complete this request.' });
        }
      }
    }
  }
}
