import { randomUUID } from 'node:crypto';
import { PendingActionService } from '../actions/pending-action-service.js';
import type { AgentTool } from './tool-registry.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const input = z.object({
  recipeId: z.string().min(1).max(100),
  body: z.string().trim().min(1).max(10_000),
}).strict();

const currentCatalogVersion = (database: Database.Database): number => {
  const row = database.prepare("SELECT version FROM app_data_versions WHERE scope = 'recipe_catalog'")
    .get() as { readonly version: number } | undefined;
  if (row === undefined) throw new Error('Recipe catalogue version is unavailable');
  return row.version;
};

export const createDraftNoteTool = (database: Database.Database): AgentTool => {
  const actions = new PendingActionService(database);
  return {
    name: 'draft_note',
    description: 'Prepare a recipe note. It does not save until the user confirms it.',
    permission: 'draft',
    input,
    definition: {
      type: 'function',
      function: {
        name: 'draft_note',
        description: 'Prepare a recipe note for user confirmation.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['recipeId', 'body'],
          properties: {
            recipeId: { type: 'string', maxLength: 100 },
            body: { type: 'string', maxLength: 10_000 },
          },
        },
      },
    },
    execute: (argumentsValue, sessionId) => {
      const value = input.parse(argumentsValue);
      const issued = actions.issue({
        kind: 'note',
        toolName: 'assistant.note.create',
        sessionId,
        arguments: value,
        payload: { ...value, noteId: randomUUID() },
        expectedDataVersions: { recipe_catalog: currentCatalogVersion(database) },
        primaryVersionScope: 'recipe_catalog',
      });
      return {
        pendingActionId: issued.pendingActionId,
        title: '保存食谱笔记',
        expiresAt: issued.expiresAt,
        kind: 'note' as const,
        preview: { recipeId: value.recipeId, body: value.body },
      };
    },
  };
};
