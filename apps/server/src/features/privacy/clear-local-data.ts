import { rm } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { SecretStore } from '../providers/secret-store.js';

const PERSONAL_TABLES = [
  'voice_messages',
  'voice_sessions',
  'pending_actions',
  'recognition_drafts',
  'recipe_variants',
  'shopping_items',
  'inventory_items',
  'notes',
  'recent_views',
  'favorites',
  'provider_profiles',
] as const;

export interface ClearLocalDataOptions {
  readonly database: Database.Database;
  readonly secretStore: SecretStore;
  readonly temporaryDirectories: readonly string[];
  readonly invalidateSessions: () => void;
}

/** Deletes local personal state while preserving the installed recipe catalogue. */
export const clearLocalData = async (options: ClearLocalDataOptions): Promise<void> => {
  const clearRows = options.database.transaction(() => {
    for (const table of PERSONAL_TABLES) options.database.exec(`DELETE FROM ${table}`);
    options.database.exec("UPDATE app_data_versions SET version = 0 WHERE scope IN ('inventory', 'shopping', 'variants')");
  });
  clearRows.immediate();
  await options.secretStore.clear();
  for (const directory of options.temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  options.database.pragma('wal_checkpoint(TRUNCATE)');
  options.database.exec('VACUUM');
  options.invalidateSessions();
};
