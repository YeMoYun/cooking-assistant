import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

export const VISION_TEMP_MAX_AGE_MS = 30 * 60 * 1_000;
export const VISION_TEMP_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface VisionTempCleanerLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface VisionTempFileCleanerOptions {
  readonly directory: string;
  readonly logger?: VisionTempCleanerLogger;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
  readonly intervalMs?: number;
}

const isMissing = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && error.code === 'ENOENT'
);

const isVisionTempName = (name: string): boolean => (
  /^vision-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:upload|webp)$/iu
    .test(name)
);

export class VisionTempFileCleaner {
  readonly #directory: string;
  readonly #intervalMs: number;
  readonly #logger: VisionTempCleanerLogger | undefined;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: VisionTempFileCleanerOptions) {
    this.#directory = resolve(options.directory);
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#maxAgeMs = options.maxAgeMs ?? VISION_TEMP_MAX_AGE_MS;
    this.#intervalMs = options.intervalMs ?? VISION_TEMP_CLEAN_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#maxAgeMs) || this.#maxAgeMs <= 0) {
      throw new TypeError('Vision temp maximum age must be positive');
    }
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new TypeError('Vision temp cleanup interval must be positive');
    }
  }

  async start(): Promise<void> {
    if (this.#timer !== undefined) {
      return;
    }
    await fs.mkdir(this.#directory, { mode: 0o700, recursive: true });
    await this.cleanOnce();
    this.#timer = setInterval(() => {
      void this.cleanOnce().catch((error: unknown) => {
        this.#logger?.warn({
          errorCode: 'vision_temp_cleanup_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        }, 'vision temp cleanup failed');
      });
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async cleanOnce(): Promise<number> {
    let entries;
    try {
      entries = await fs.readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return 0;
      }
      throw error;
    }

    const cutoff = this.#now() - this.#maxAgeMs;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !isVisionTempName(entry.name)) {
        continue;
      }
      const path = join(this.#directory, entry.name);
      try {
        const stat = await fs.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) {
          continue;
        }
        await fs.unlink(path);
        removed += 1;
      } catch (error) {
        if (!isMissing(error)) {
          this.#logger?.warn({
            errorCode: 'vision_temp_file_remove_failed',
            errorName: error instanceof Error ? error.name : 'unknown',
          }, 'vision temp file could not be removed');
        }
      }
    }

    if (removed > 0) {
      this.#logger?.info({ removed }, 'orphan vision temp files removed');
    }
    return removed;
  }
}
