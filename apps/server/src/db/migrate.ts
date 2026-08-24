import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

const MIGRATION_CHECKSUM_MISMATCH = 'migration_checksum_mismatch';
const DUPLICATE_MIGRATION_VERSION = 'duplicate_migration_version';
const DATABASE_IDENTITY_MISMATCH = 'database_identity_mismatch';

class MigrationChecksumMismatchError extends Error {
  readonly code = MIGRATION_CHECKSUM_MISMATCH;

  constructor() {
    super(MIGRATION_CHECKSUM_MISMATCH);
    this.name = 'MigrationChecksumMismatchError';
  }
}

class DuplicateMigrationVersionError extends Error {
  readonly code = DUPLICATE_MIGRATION_VERSION;

  constructor() {
    super(DUPLICATE_MIGRATION_VERSION);
    this.name = 'DuplicateMigrationVersionError';
  }
}

class DatabaseIdentityMismatchError extends Error {
  readonly code = DATABASE_IDENTITY_MISMATCH;

  constructor() {
    super(DATABASE_IDENTITY_MISMATCH);
    this.name = 'DatabaseIdentityMismatchError';
  }
}

const readMigrations = (migrationsDirectory: string): Migration[] => {
  const migrations = readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .map((fileName) => {
      const match = /^(\d+)_([a-z0-9_-]+)\.sql$/u.exec(fileName);
      if (match === null) {
        throw new Error(`Invalid migration file name: ${fileName}`);
      }

      const version = Number(match[1]);
      const sql = readFileSync(join(migrationsDirectory, fileName), 'utf8')
        .replace(/\r\n?/gu, '\n');
      return {
        version,
        name: fileName,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new DuplicateMigrationVersionError();
    }
    versions.add(migration.version);
  }

  return migrations;
};

const readAppliedMigrations = (
  db: Database.Database,
): Map<number, AppliedMigration> => {
  const migrationsTable = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (migrationsTable === undefined) {
    const userTable = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      LIMIT 1
    `).get();
    if (userTable !== undefined) {
      throw new DatabaseIdentityMismatchError();
    }
    return new Map();
  }

  const migrations = db.prepare(`
    SELECT version, name, checksum FROM schema_migrations
  `).all() as AppliedMigration[];
  return new Map(migrations.map((migration) => [
    migration.version,
    migration,
  ]));
};

export const migrateDatabase = (
  db: Database.Database,
  migrationsDirectory: string,
): void => {
  const migrations = readMigrations(migrationsDirectory);
  const migrationsByVersion = new Map(migrations.map((migration) => [
    migration.version,
    migration,
  ]));
  const appliedMigrations = readAppliedMigrations(db);

  for (const appliedMigration of appliedMigrations.values()) {
    const migration = migrationsByVersion.get(appliedMigration.version);
    if (
      migration === undefined
      || appliedMigration.name !== migration.name
      || appliedMigration.checksum !== migration.checksum
    ) {
      throw new MigrationChecksumMismatchError();
    }
  }

  for (const migration of migrations) {
    if (appliedMigrations.has(migration.version)) {
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
    })();
  }
};
