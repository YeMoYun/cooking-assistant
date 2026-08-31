import { InventoryRepository } from '../inventory/inventory-repository.js';
import type { AgentTool } from './tool-registry.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const input = z.object({}).strict();

export const createReadInventoryTool = (database: Database.Database): AgentTool => {
  const repository = new InventoryRepository(database);
  return {
    name: 'read_inventory',
    description: 'Read the explicitly shared local inventory. This is read-only.',
    permission: 'read',
    requiredContext: 'includeInventory',
    input,
    definition: {
      type: 'function',
      function: {
        name: 'read_inventory',
        description: 'Read the user-authorized local inventory.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
    },
    execute: () => repository.getSnapshot(),
  };
};
