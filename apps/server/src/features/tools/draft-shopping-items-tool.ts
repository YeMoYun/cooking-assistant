import { ShoppingService } from '../shopping/shopping-service.js';
import type { AgentTool } from './tool-registry.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const input = z.object({
  recipes: z.array(z.object({
    recipeId: z.string().min(1).max(100),
    servings: z.number().finite().positive().max(1_000),
  }).strict()).min(1).max(10),
}).strict();

export const createDraftShoppingItemsTool = (database: Database.Database): AgentTool => {
  const service = new ShoppingService(database);
  return {
    name: 'draft_shopping_items',
    description: 'Create a shopping-list preview. It does not save until the user confirms it.',
    permission: 'draft',
    input,
    definition: {
      type: 'function',
      function: {
        name: 'draft_shopping_items',
        description: 'Prepare a shopping-list preview for selected recipes. Never claim it was saved.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['recipes'],
          properties: { recipes: { type: 'array', maxItems: 10 } },
        },
      },
    },
    execute: (argumentsValue, sessionId) => service.generatePreview(input.parse(argumentsValue), sessionId),
  };
};
