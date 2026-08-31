import { randomUUID } from 'node:crypto';

export interface SecretStore {
  put(secret: string): Promise<string>;
  get(keyRef: string): Promise<string>;
  delete(keyRef: string): Promise<void>;
  clear(): Promise<void>;
}

export class SecretNotFoundError extends Error {
  constructor() {
    super('Secret reference does not exist');
    this.name = 'SecretNotFoundError';
  }
}

export class MemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, Buffer>();

  async put(secret: string): Promise<string> {
    const bytes = Buffer.from(secret, 'utf8');
    try {
      const keyRef = randomUUID();
      this.#secrets.set(keyRef, Buffer.from(bytes));
      return keyRef;
    } finally {
      bytes.fill(0);
    }
  }

  async get(keyRef: string): Promise<string> {
    const stored = this.#secrets.get(keyRef);
    if (stored === undefined) {
      throw new SecretNotFoundError();
    }
    const temporary = Buffer.from(stored);
    try {
      return temporary.toString('utf8');
    } finally {
      temporary.fill(0);
    }
  }

  async delete(keyRef: string): Promise<void> {
    const stored = this.#secrets.get(keyRef);
    if (stored !== undefined) {
      stored.fill(0);
      this.#secrets.delete(keyRef);
    }
  }

  async clear(): Promise<void> {
    for (const secret of this.#secrets.values()) {
      secret.fill(0);
    }
    this.#secrets.clear();
  }
}
