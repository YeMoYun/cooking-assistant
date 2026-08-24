import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { resolveAppPaths } from '../config.js';
import { migrateDatabase } from './migrate.js';

export const openDatabase = (
  databasePath: string,
  migrationsDirectory = resolveAppPaths({
    dataDirectory: dirname(databasePath),
  }).migrationsDirectory,
): Database.Database => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);

  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.pragma('secure_delete = ON');
    migrateDatabase(db, migrationsDirectory);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};
