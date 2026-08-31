import type { ContextSelection } from '@xiaochu/shared';
import { z } from 'zod';

export type ToolPermission = 'read' | 'draft';

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly permission: ToolPermission;
  readonly requiredContext?: keyof Pick<
    ContextSelection,
    'includeInventory' | 'includeShopping'
  >;
  readonly input: z.ZodType;
  readonly definition: Readonly<Record<string, unknown>>;
  execute(argumentsValue: unknown, sessionId: string): Promise<unknown> | unknown;
}

export class ToolRegistry {
  constructor(private readonly tools: readonly AgentTool[]) {}

  allowed(selection: ContextSelection, providerSupportsTools: boolean): readonly AgentTool[] {
    if (!providerSupportsTools) return [];
    return this.tools.filter((tool) => (
      tool.requiredContext === undefined || selection[tool.requiredContext]
    ));
  }

  get(name: string, selection: ContextSelection, providerSupportsTools: boolean): AgentTool | undefined {
    return this.allowed(selection, providerSupportsTools).find((tool) => tool.name === name);
  }
}
