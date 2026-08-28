import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { resolveAppPaths } from '../../apps/server/src/config.js';
import { openDatabase } from '../../apps/server/src/db/database.js';
import {
  CatalogImportError,
  importRecipeCatalog,
} from '../../apps/server/src/features/import/staging-importer.js';
import type { ImportMode } from '../../apps/server/src/features/import/import-report.js';

interface CliOptions {
  readonly inputPath: string;
  readonly mode: ImportMode;
  readonly databasePath: string;
}

class CliArgumentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CliArgumentError';
    this.code = code;
  }
}

const parseArguments = (arguments_: readonly string[]): CliOptions => {
  const values = new Map<string, string>();
  const allowed = new Set(['--input', '--mode', '--database']);
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === undefined || !allowed.has(flag)) {
      throw new CliArgumentError('unknown_argument');
    }
    if (values.has(flag)) {
      throw new CliArgumentError('duplicate_argument');
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      throw new CliArgumentError('missing_argument_value');
    }
    values.set(flag, value);
    index += 1;
  }

  const input = values.get('--input');
  const mode = values.get('--mode');
  if (input === undefined || mode === undefined) {
    throw new CliArgumentError('missing_required_argument');
  }
  if (mode !== 'merge' && mode !== 'replace') {
    throw new CliArgumentError('invalid_import_mode');
  }
  const database = values.get('--database') ?? resolveAppPaths().databasePath;
  return {
    inputPath: resolve(input),
    mode,
    databasePath: resolve(database),
  };
};

const safeFailureCode = (error: unknown): string => {
  if (error instanceof CliArgumentError || error instanceof CatalogImportError) {
    return error.code;
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  ) {
    return 'input_not_found';
  }
  return 'catalog_import_failed';
};

const main = async (): Promise<void> => {
  let db: Database.Database | undefined;
  try {
    const options = parseArguments(process.argv.slice(2));
    db = openDatabase(options.databasePath);
    const report = await importRecipeCatalog({
      db,
      inputPath: options.inputPath,
      mode: options.mode,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    // Exit 2 means the valid subset committed but one or more source rows were rejected.
    if (report.rejected > 0) {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: safeFailureCode(error) } })}\n`);
    process.exitCode = 1;
  } finally {
    if (db?.open === true) {
      db.close();
    }
  }
};

void main();
