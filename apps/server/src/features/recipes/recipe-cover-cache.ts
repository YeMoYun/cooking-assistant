import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'undici';
import sharp from 'sharp';
import { OutboundUrlPolicy } from '../providers/outbound-url-policy.js';
import { createSafeDispatcher } from '../providers/safe-dispatcher.js';

const MAX_SOURCE_BYTES = 8 * 1_024 * 1_024;
const USER_AGENT = 'XiaoChuLocal/0.1 (recipe cover cache)';

export interface CachedRecipeCover {
  readonly body: Buffer;
  readonly etag: string;
}

export interface RecipeCoverCacheOptions {
  readonly cacheDirectory: string;
  readonly policy?: OutboundUrlPolicy;
}

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export class RecipeCoverCache {
  readonly #cacheDirectory: string;
  readonly #inflight = new Map<string, Promise<CachedRecipeCover>>();
  readonly #policy: OutboundUrlPolicy;

  constructor(options: RecipeCoverCacheOptions) {
    this.#cacheDirectory = options.cacheDirectory;
    this.#policy = options.policy ?? new OutboundUrlPolicy();
  }

  get(recipeId: string, remoteUrl: string): Promise<CachedRecipeCover> {
    const cacheKey = `${digest(recipeId).slice(0, 20)}-${digest(remoteUrl).slice(0, 16)}`;
    const existing = this.#inflight.get(cacheKey);
    if (existing !== undefined) return existing;
    const pending = this.#loadOrCreate(`${cacheKey}.webp`, remoteUrl)
      .finally(() => this.#inflight.delete(cacheKey));
    this.#inflight.set(cacheKey, pending);
    return pending;
  }

  async #loadOrCreate(fileName: string, remoteUrl: string): Promise<CachedRecipeCover> {
    await mkdir(this.#cacheDirectory, { recursive: true });
    const filePath = join(this.#cacheDirectory, fileName);
    try {
      return this.#result(await readFile(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const source = await this.#download(remoteUrl);
    const body = await sharp(source, { failOn: 'warning' })
      .rotate()
      .resize(960, 720, { fit: 'cover', position: 'centre' })
      .webp({ effort: 4, quality: 82 })
      .toBuffer();
    const temporary = join(this.#cacheDirectory, `.${fileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: 'wx' });
      await rename(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.#result(body);
  }

  #result(body: Buffer): CachedRecipeCover {
    return { body, etag: `"${digest(body)}"` };
  }

  async #download(input: string): Promise<Buffer> {
    let current = input;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const validated = await this.#policy.validateResourceUrl(current);
      const safeDispatcher = createSafeDispatcher({
        boundOrigin: validated.origin,
        connectTimeoutMs: 8_000,
        developmentLoopback: false,
        policy: this.#policy,
        targetUrl: validated.normalizedUrl,
      });
      try {
        const response = await request(validated.normalizedUrl, {
          method: 'GET',
          headers: {
            accept: 'image/avif,image/webp,image/jpeg,image/png,image/*',
            'user-agent': USER_AGENT,
          },
          bodyTimeout: 20_000,
          dispatcher: safeDispatcher.dispatcher,
          headersTimeout: 15_000,
        });
        if (response.statusCode >= 300 && response.statusCode < 400) {
          const location = response.headers.location;
          await response.body.dump();
          if (typeof location !== 'string' || redirect === 3) {
            throw new Error('Recipe cover redirect is invalid');
          }
          current = new URL(location, validated.normalizedUrl).toString();
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          await response.body.dump();
          throw new Error(`Recipe cover request returned HTTP ${response.statusCode}`);
        }
        const contentType = String(response.headers['content-type'] ?? '').toLocaleLowerCase('en-US');
        if (contentType !== '' && !contentType.startsWith('image/')) {
          await response.body.dump();
          throw new Error('Recipe cover response is not an image');
        }
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of response.body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_SOURCE_BYTES) throw new Error('Recipe cover image is too large');
          chunks.push(buffer);
        }
        return Buffer.concat(chunks, total);
      } finally {
        await safeDispatcher.close().catch(() => undefined);
      }
    }
    throw new Error('Recipe cover has too many redirects');
  }
}

