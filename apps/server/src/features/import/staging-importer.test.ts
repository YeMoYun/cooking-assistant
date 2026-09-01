import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { importRecipeCatalog } from './staging-importer.js';

const roots: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('imports staged recipes without writing through an active SQLite iterator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xiaochu-import-'));
  roots.push(root);
  const database = openDatabase(join(root, 'catalog.sqlite'));
  databases.push(database);
  const inputPath = fileURLToPath(new URL(
    '../../../../../fixtures/recipes/mini-catalog.jsonl',
    import.meta.url,
  ));

  const report = await importRecipeCatalog({
    db: database,
    inputPath,
    mode: 'replace',
  });

  expect(report.accepted).toBe(3);
  expect(database.prepare('SELECT COUNT(*) AS count FROM recipes').get()).toEqual({ count: 3 });
});

