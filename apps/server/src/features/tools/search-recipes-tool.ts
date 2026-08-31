import { RecipeSearchRepository } from '../recipes/search-repository.js';
import { RecipeSearchService } from '../recipes/search-service.js';
import type { AgentTool } from './tool-registry.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const input = z.object({
  query: z.string().trim().min(1).max(80),
}).strict();

export const createSearchRecipesTool = (database: Database.Database): AgentTool => {
  const service = new RecipeSearchService(new RecipeSearchRepository(database));
  return {
    name: 'search_recipes',
    description: 'Search the local recipe catalogue. This is read-only.',
    permission: 'read',
    input,
    definition: {
      type: 'function',
      function: {
        name: 'search_recipes',
        description: 'Search local recipes by a short Chinese query.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: { query: { type: 'string', maxLength: 80 } },
        },
      },
    },
    execute: (argumentsValue) => {
      const value = input.parse(argumentsValue);
      return service.search({ q: value.query, limit: 8 });
    },
  };
};
