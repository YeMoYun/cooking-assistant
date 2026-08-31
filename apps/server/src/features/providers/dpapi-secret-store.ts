import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../../config.js';
import {
  SecretNotFoundError,
  type SecretStore,
} from './secret-store.js';

const SECRET_DOCUMENT_VERSION = 1;
const MAX_SECRET_DOCUMENT_BYTES = 2 * 1_024 * 1_024;
const KEY_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface SecretDocument {
  readonly version: typeof SECRET_DOCUMENT_VERSION;
  readonly secrets: Readonly<Record<string, string>>;
}

interface DpapiPersistence {
  save(contents: string): Promise<void>;
  load(): Promise<string | null>;
  delete(): Promise<boolean>;
  verifyPersistence(): Promise<boolean>;
}

export interface DpapiSecretStoreOptions {
  readonly filePath?: string;
}

const emptyDocument = (): SecretDocument => ({
  version: SECRET_DOCUMENT_VERSION,
  secrets: {},
});

const parseDocument = (raw: string): SecretDocument => {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_DOCUMENT_BYTES) {
    throw new Error('Encrypted secret document is too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Encrypted secret document is invalid');
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('version' in parsed)
    || parsed.version !== SECRET_DOCUMENT_VERSION
    || !('secrets' in parsed)
    || typeof parsed.secrets !== 'object'
    || parsed.secrets === null
    || Array.isArray(parsed.secrets)
  ) {
    throw new Error('Encrypted secret document is invalid');
  }

  const secrets: Record<string, string> = {};
  for (const [keyRef, encoded] of Object.entries(parsed.secrets)) {
    if (
      !KEY_REF_PATTERN.test(keyRef)
      || typeof encoded !== 'string'
      || encoded.length > 100_000
      || !BASE64_PATTERN.test(encoded)
    ) {
      throw new Error('Encrypted secret document is invalid');
    }
    secrets[keyRef] = encoded;
  }
  return { version: SECRET_DOCUMENT_VERSION, secrets };
};

export class DpapiSecretStore implements SecretStore {
  #knownEmptyAfterClear = false;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly persistence: DpapiPersistence,
    private readonly filePath: string,
  ) {}

  static async create(
    options: DpapiSecretStoreOptions = {},
  ): Promise<DpapiSecretStore> {
    if (process.platform !== 'win32') {
      throw new Error('Windows DPAPI is required for provider secrets');
    }

    const filePath = options.filePath
      ?? join(resolveAppPaths().dataDirectory, 'secrets.dat');
    let extension: typeof import('@azure/msal-node-extensions');
    try {
      extension = await import('@azure/msal-node-extensions');
    } catch {
      throw new Error('Windows DPAPI could not be initialized');
    }

    try {
      const persistence = await extension.FilePersistenceWithDataProtection.create(
        filePath,
        extension.DataProtectionScope.CurrentUser,
      );
      if (!await persistence.verifyPersistence()) {
        throw new Error('DPAPI persistence verification failed');
      }
      await chmod(filePath, 0o600);
      return new DpapiSecretStore(persistence, filePath);
    } catch {
      throw new Error('Windows DPAPI could not be initialized');
    }
  }

  put(secret: string): Promise<string> {
    return this.serialized(async () => {
      const temporary = Buffer.from(secret, 'utf8');
      try {
        const document = await this.readDocument();
        const keyRef = randomUUID();
        const next: SecretDocument = {
          version: SECRET_DOCUMENT_VERSION,
          secrets: {
            ...document.secrets,
            [keyRef]: temporary.toString('base64'),
          },
        };
        await this.writeDocument(next);
        return keyRef;
      } finally {
        temporary.fill(0);
      }
    });
  }

  get(keyRef: string): Promise<string> {
    return this.serialized(async () => {
      if (!KEY_REF_PATTERN.test(keyRef)) {
        throw new SecretNotFoundError();
      }
      const document = await this.readDocument();
      const encoded = document.secrets[keyRef];
      if (encoded === undefined) {
        throw new SecretNotFoundError();
      }
      const temporary = Buffer.from(encoded, 'base64');
      try {
        return temporary.toString('utf8');
      } finally {
        temporary.fill(0);
      }
    });
  }

  delete(keyRef: string): Promise<void> {
    return this.serialized(async () => {
      if (!KEY_REF_PATTERN.test(keyRef)) {
        return;
      }
      const document = await this.readDocument();
      if (document.secrets[keyRef] === undefined) {
        return;
      }
      const secrets = { ...document.secrets };
      delete secrets[keyRef];
      await this.writeDocument({ version: SECRET_DOCUMENT_VERSION, secrets });
    });
  }

  clear(): Promise<void> {
    return this.serialized(async () => {
      await this.persistence.delete();
      this.#knownEmptyAfterClear = true;
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readDocument(): Promise<SecretDocument> {
    if (this.#knownEmptyAfterClear) {
      return emptyDocument();
    }
    const raw = await this.persistence.load();
    return raw === null || raw.length === 0 ? emptyDocument() : parseDocument(raw);
  }

  private async writeDocument(document: SecretDocument): Promise<void> {
    const serialized = JSON.stringify(document);
    const temporary = Buffer.from(serialized, 'utf8');
    try {
      await this.persistence.save(temporary.toString('utf8'));
      await chmod(this.filePath, 0o600);
      this.#knownEmptyAfterClear = false;
    } finally {
      temporary.fill(0);
    }
  }
}
