import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../config.js';
import { openDatabase } from './database.js';

describe('openDatabase', () => {
  const roots: string[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    databases.splice(0).forEach((db) => {
      if (db.open) {
        db.close();
      }
    });
    roots.splice(0).forEach((root) => {
      rmSync(root, { recursive: true, force: true });
    });
  });

  it('enables foreign keys, WAL, busy timeout and migrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    roots.push(root);
    const db = openDatabase(join(root, 'app.sqlite'));
    databases.push(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    expect(
      db.prepare('select count(*) as count from schema_migrations').get(),
    ).toEqual({ count: 1 });
    db.close();
  });

  it('rejects a non-empty database without migration identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    const databasePath = join(root, 'app.sqlite');
    roots.push(root);
    const unrelatedConnection = new Database(databasePath);
    databases.push(unrelatedConnection);
    unrelatedConnection.exec(`
      CREATE TABLE unrelated_table (id INTEGER PRIMARY KEY);
    `);
    unrelatedConnection.close();

    let migrationError: unknown;
    try {
      const unexpectedConnection = openDatabase(databasePath);
      databases.push(unexpectedConnection);
      unexpectedConnection.close();
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({
      code: 'database_identity_mismatch',
      message: 'database_identity_mismatch',
    });
    const verificationConnection = new Database(databasePath);
    databases.push(verificationConnection);
    expect(verificationConnection.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([{ name: 'unrelated_table' }]);
    verificationConnection.close();
    rmSync(databasePath);
    expect(existsSync(databasePath)).toBe(false);
  });

  it('rolls back only the failing migration and keeps prior migrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    const migrationsDirectory = join(root, 'migrations');
    const databasePath = join(root, 'app.sqlite');
    roots.push(root);
    mkdirSync(migrationsDirectory);
    writeFileSync(join(migrationsDirectory, '001_core.sql'), `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE committed_001 (id INTEGER PRIMARY KEY);
    `);
    writeFileSync(join(migrationsDirectory, '002_failing.sql'), `
      CREATE TABLE partial_002 (id INTEGER PRIMARY KEY);
      THIS IS INVALID SQL;
    `);

    expect(() => openDatabase(databasePath, migrationsDirectory)).toThrow();

    const db = new Database(databasePath);
    databases.push(db);
    expect(
      db.prepare('SELECT version, name FROM schema_migrations').all(),
    ).toEqual([{ version: 1, name: '001_core.sql' }]);
    expect(
      db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'committed_001'
      `).get(),
    ).toEqual({ name: 'committed_001' });
    expect(
      db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'partial_002'
      `).get(),
    ).toBeUndefined();
  });

  it('rejects changed applied migration content without altering schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    const migrationsDirectory = join(root, 'migrations');
    const databasePath = join(root, 'app.sqlite');
    const migrationPath = join(migrationsDirectory, '001_core.sql');
    const originalMigration = `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE stable_business (id INTEGER PRIMARY KEY);
    `;
    roots.push(root);
    mkdirSync(migrationsDirectory);
    writeFileSync(migrationPath, originalMigration);

    const firstConnection = openDatabase(databasePath, migrationsDirectory);
    databases.push(firstConnection);
    const schemaBefore = firstConnection.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    firstConnection.close();
    writeFileSync(migrationPath, `${originalMigration}
      CREATE TABLE tampered_business (id INTEGER PRIMARY KEY);
    `);

    let migrationError: unknown;
    try {
      openDatabase(databasePath, migrationsDirectory);
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({
      code: 'migration_checksum_mismatch',
      message: 'migration_checksum_mismatch',
    });
    const verificationConnection = new Database(databasePath);
    databases.push(verificationConnection);
    expect(verificationConnection.prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all()).toEqual(schemaBefore);
  });

  it('keeps migration checksums stable across SQL line endings', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    const migrationsDirectory = join(root, 'migrations');
    const databasePath = join(root, 'app.sqlite');
    const migrationPath = join(migrationsDirectory, '001_core.sql');
    const lfMigration = [
      'CREATE TABLE schema_migrations (',
      '  version INTEGER PRIMARY KEY,',
      '  name TEXT NOT NULL,',
      '  checksum TEXT NOT NULL,',
      '  applied_at TEXT NOT NULL',
      ');',
      'CREATE TABLE stable_line_endings (id INTEGER PRIMARY KEY);',
      '',
    ].join('\n');
    roots.push(root);
    mkdirSync(migrationsDirectory);
    writeFileSync(migrationPath, lfMigration);

    const firstConnection = openDatabase(databasePath, migrationsDirectory);
    databases.push(firstConnection);
    const migrationRow = firstConnection.prepare(`
      SELECT version, name, checksum FROM schema_migrations WHERE version = 1
    `).get();
    firstConnection.close();

    writeFileSync(migrationPath, lfMigration.replaceAll('\n', '\r\n'));
    const crlfConnection = openDatabase(databasePath, migrationsDirectory);
    databases.push(crlfConnection);
    expect(crlfConnection.prepare(`
      SELECT version, name, checksum FROM schema_migrations WHERE version = 1
    `).get()).toEqual(migrationRow);
    crlfConnection.close();

    writeFileSync(migrationPath, lfMigration.replaceAll('\n', '\r'));
    const crConnection = openDatabase(databasePath, migrationsDirectory);
    databases.push(crConnection);
    expect(crConnection.prepare(`
      SELECT version, name, checksum FROM schema_migrations WHERE version = 1
    `).get()).toEqual(migrationRow);
  });

  it('validates all applied migrations before applying pending migrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    const migrationsDirectory = join(root, 'migrations');
    const databasePath = join(root, 'app.sqlite');
    const thirdMigrationPath = join(migrationsDirectory, '003_third.sql');
    const thirdMigration = `
      CREATE TABLE stable_003 (id INTEGER PRIMARY KEY);
    `;
    roots.push(root);
    mkdirSync(migrationsDirectory);
    writeFileSync(join(migrationsDirectory, '001_core.sql'), `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE stable_001 (id INTEGER PRIMARY KEY);
    `);
    writeFileSync(thirdMigrationPath, thirdMigration);

    const firstConnection = openDatabase(databasePath, migrationsDirectory);
    databases.push(firstConnection);
    firstConnection.close();
    writeFileSync(join(migrationsDirectory, '002_pending.sql'), `
      CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY);
    `);
    writeFileSync(thirdMigrationPath, `${thirdMigration}
      -- changed after version 003 was applied
    `);

    let migrationError: unknown;
    try {
      openDatabase(databasePath, migrationsDirectory);
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({
      code: 'migration_checksum_mismatch',
      message: 'migration_checksum_mismatch',
    });
    const verificationConnection = new Database(databasePath);
    databases.push(verificationConnection);
    expect(verificationConnection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'should_not_exist'
    `).get()).toBeUndefined();
    expect(verificationConnection.prepare(`
      SELECT version FROM schema_migrations WHERE version = 2
    `).get()).toBeUndefined();
  });

  it('applies migration files in numeric version order', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    const migrationsDirectory = join(root, 'migrations');
    roots.push(root);
    mkdirSync(migrationsDirectory);
    writeFileSync(join(migrationsDirectory, '1_core.sql'), `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE migration_order (version INTEGER NOT NULL);
    `);
    writeFileSync(join(migrationsDirectory, '10_tenth.sql'), `
      INSERT INTO migration_order (version) VALUES (10);
    `);
    writeFileSync(join(migrationsDirectory, '2_second.sql'), `
      INSERT INTO migration_order (version) VALUES (2);
    `);

    const db = openDatabase(join(root, 'app.sqlite'), migrationsDirectory);
    databases.push(db);

    expect(
      db.prepare('SELECT version FROM migration_order ORDER BY rowid').all(),
    ).toEqual([{ version: 2 }, { version: 10 }]);
  });

  it('rejects duplicate migration versions before applying either file', () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaochu-db-'));
    const migrationsDirectory = join(root, 'migrations');
    const databasePath = join(root, 'app.sqlite');
    roots.push(root);
    mkdirSync(migrationsDirectory);
    writeFileSync(join(migrationsDirectory, '001_core.sql'), `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE should_not_be_applied (id INTEGER PRIMARY KEY);
    `);
    writeFileSync(join(migrationsDirectory, '01_duplicate.sql'), `
      CREATE TABLE duplicate_side_effect (id INTEGER PRIMARY KEY);
    `);

    let migrationError: unknown;
    try {
      openDatabase(databasePath, migrationsDirectory);
    } catch (error) {
      migrationError = error;
    }

    expect(migrationError).toMatchObject({
      code: 'duplicate_migration_version',
      message: 'duplicate_migration_version',
    });
    const verificationConnection = new Database(databasePath);
    databases.push(verificationConnection);
    expect(verificationConnection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all()).toEqual([]);
  });
});

describe('resolveAppPaths', () => {
  it.each([
    ['source', join('workspace', 'apps', 'server', 'src', 'config.ts')],
    ['built', join('workspace', 'apps', 'server', 'dist', 'index.js')],
  ])('resolves %s migrations beside the executing module', (_label, modulePath) => {
    const absoluteModulePath = join(process.cwd(), modulePath);
    const moduleUrl = pathToFileURL(absoluteModulePath).href;

    expect(resolveAppPaths({
      dataDirectory: join('test-data'),
      moduleUrl,
    }).migrationsDirectory).toBe(
      join(dirname(absoluteModulePath), 'db', 'migrations'),
    );
  });

  it('uses an explicit data directory without LOCALAPPDATA', () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const dataDirectory = join('test-data', 'xiaochu');

    try {
      delete process.env.LOCALAPPDATA;

      expect(resolveAppPaths({ dataDirectory })).toMatchObject({
        dataDirectory,
        databasePath: join(dataDirectory, 'xiaochu.sqlite'),
      });
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });

  it('uses the XiaoChu directory under LOCALAPPDATA by default', () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const localAppData = join('test-data', 'local-app-data');

    try {
      process.env.LOCALAPPDATA = localAppData;

      expect(resolveAppPaths()).toMatchObject({
        dataDirectory: join(localAppData, 'XiaoChu'),
        databasePath: join(localAppData, 'XiaoChu', 'xiaochu.sqlite'),
      });
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });

  it('fails closed without LOCALAPPDATA or an explicit override', () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;

    try {
      delete process.env.LOCALAPPDATA;

      expect(() => resolveAppPaths()).toThrow(
        'LOCALAPPDATA is required unless dataDirectory is provided',
      );
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    }
  });

  it('does not resolve migrations from process.cwd()', () => {
    const originalWorkingDirectory = process.cwd();
    const unrelatedDirectory = mkdtempSync(join(tmpdir(), 'xiaochu-cwd-'));
    const modulePath = join(
      originalWorkingDirectory,
      'src',
      'config.ts',
    );

    try {
      process.chdir(unrelatedDirectory);

      expect(resolveAppPaths({
        dataDirectory: join(unrelatedDirectory, 'data'),
        moduleUrl: pathToFileURL(modulePath).href,
      }).migrationsDirectory).toBe(
        join(originalWorkingDirectory, 'src', 'db', 'migrations'),
      );
    } finally {
      process.chdir(originalWorkingDirectory);
      rmSync(unrelatedDirectory, { recursive: true, force: true });
    }
  });
});
