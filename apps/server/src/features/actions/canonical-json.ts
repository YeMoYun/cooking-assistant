import { createHash } from 'node:crypto';

const MAX_DEPTH = 64;
const MAX_ENTRIES = 100_000;

interface CanonicalState {
  entries: number;
  readonly seen: WeakSet<object>;
}

const canonicalize = (
  value: unknown,
  depth: number,
  state: CanonicalState,
): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON requires finite numbers');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object' || depth > MAX_DEPTH) {
    throw new TypeError('Value is not canonical JSON data');
  }
  if (state.seen.has(value)) {
    throw new TypeError('Canonical JSON cannot contain cycles');
  }
  state.seen.add(value);

  try {
    if (Array.isArray(value)) {
      state.entries += value.length;
      if (state.entries > MAX_ENTRIES) {
        throw new TypeError('Canonical JSON is too large');
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1) {
        throw new TypeError('Canonical JSON arrays must be dense');
      }
      return `[${value.map((item) => canonicalize(
        item,
        depth + 1,
        state,
      )).join(',')}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON objects must be plain');
    }
    const keys = Object.keys(value).sort();
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new TypeError('Canonical JSON objects require plain enumerable keys');
    }
    state.entries += keys.length;
    if (state.entries > MAX_ENTRIES) {
      throw new TypeError('Canonical JSON is too large');
    }
    const record = value as Record<string, unknown>;
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('Canonical JSON cannot contain accessors');
      }
      return `${JSON.stringify(key)}:${canonicalize(
        descriptor.value,
        depth + 1,
        state,
      )}`;
    }).join(',')}}`;
  } finally {
    state.seen.delete(value);
  }
};

export const canonicalJson = (value: unknown): string => canonicalize(value, 0, {
  entries: 0,
  seen: new WeakSet<object>(),
});

export const canonicalJsonHash = (value: unknown): string => createHash('sha256')
  .update(canonicalJson(value), 'utf8')
  .digest('hex');
