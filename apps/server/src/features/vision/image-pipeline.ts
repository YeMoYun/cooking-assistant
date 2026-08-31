import { randomUUID as nodeRandomUUID } from 'node:crypto';
import {
  createWriteStream,
  promises as fs,
  type WriteStream,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@xiaochu/shared';
import sharp from 'sharp';

export const VISION_MAX_IMAGE_BYTES = 10 * 1_024 * 1_024;
export const VISION_MAX_IMAGE_EDGE = 1_600;
const VISION_MAX_INPUT_PIXELS = 64 * 1_024 * 1_024;

export type AcceptedVisionMimeType = (
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
);

export interface PreparedVisionImage {
  readonly path: string;
  readonly mimeType: 'image/webp';
  readonly byteLength: number;
  readonly sourceByteLength: number;
  readonly width: number;
  readonly height: number;
}

export interface VisionImagePipelineOptions {
  readonly tempDirectory: string;
  readonly randomUUID?: () => string;
}

const acceptedMimeTypes = new Set<AcceptedVisionMimeType>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const invalidImage = (): AppError => new AppError(
  'invalid_image',
  '图片无法读取，请重新拍摄或改用 JPEG、PNG、WebP 图片',
  400,
);

const cancelled = (): AppError => new AppError(
  'cancelled',
  '图片识别已取消',
  499,
);

const isAbortError = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && 'name' in error
  && error.name === 'AbortError'
);

const isAborted = (signal: AbortSignal | undefined): boolean => (
  signal?.aborted ?? false
);

const detectMimeType = (header: Buffer): AcceptedVisionMimeType | undefined => {
  if (
    header.length >= 3
    && header[0] === 0xff
    && header[1] === 0xd8
    && header[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    header.length >= 8
    && header.subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))
  ) {
    return 'image/png';
  }
  if (
    header.length >= 12
    && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
};

const removeFileIfPresent = async (path: string): Promise<void> => {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (
      typeof error !== 'object'
      || error === null
      || !('code' in error)
      || error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
};

export class VisionImagePipeline {
  readonly #tempDirectory: string;
  readonly #randomUUID: () => string;

  constructor(options: VisionImagePipelineOptions) {
    this.#tempDirectory = resolve(options.tempDirectory);
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  get tempDirectory(): string {
    return this.#tempDirectory;
  }

  async prepare(
    source: Readable,
    declaredMimeType: string,
    signal?: AbortSignal,
  ): Promise<PreparedVisionImage> {
    if (!acceptedMimeTypes.has(declaredMimeType as AcceptedVisionMimeType)) {
      source.resume();
      throw new AppError(
        'unsupported_image_type',
        '只支持 JPEG、PNG 和 WebP 图片',
        415,
      );
    }
    if (isAborted(signal)) {
      source.destroy();
      throw cancelled();
    }

    await fs.mkdir(this.#tempDirectory, { mode: 0o700, recursive: true });
    const rawPath = join(
      this.#tempDirectory,
      `vision-${this.#randomUUID()}.upload`,
    );
    const processedPath = join(
      this.#tempDirectory,
      `vision-${this.#randomUUID()}.webp`,
    );
    let sourceByteLength = 0;

    try {
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sourceByteLength += chunk.byteLength;
          if (sourceByteLength > VISION_MAX_IMAGE_BYTES) {
            callback(new AppError(
              'image_too_large',
              '图片不能超过 10 MiB',
              413,
            ));
            return;
          }
          callback(null, chunk);
        },
      });
      const destination: WriteStream = createWriteStream(rawPath, {
        flags: 'wx',
        mode: 0o600,
      });
      await pipeline(source, limiter, destination, {
        ...(signal === undefined ? {} : { signal }),
      });
      if (sourceByteLength === 0) {
        throw invalidImage();
      }

      const file = await fs.open(rawPath, 'r');
      let header: Buffer;
      try {
        header = Buffer.alloc(16);
        const read = await file.read(header, 0, header.length, 0);
        header = header.subarray(0, read.bytesRead);
      } finally {
        await file.close();
      }
      const detectedMimeType = detectMimeType(header);
      if (detectedMimeType === undefined) {
        throw new AppError(
          'unsupported_image_type',
          '图片内容不是受支持的 JPEG、PNG 或 WebP 格式',
          415,
        );
      }
      if (detectedMimeType !== declaredMimeType) {
        throw new AppError(
          'image_type_mismatch',
          '图片声明格式与实际内容不一致',
          415,
        );
      }

      const transformer = sharp(rawPath, {
        failOn: 'error',
        limitInputPixels: VISION_MAX_INPUT_PIXELS,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: VISION_MAX_IMAGE_EDGE,
          height: VISION_MAX_IMAGE_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ effort: 4, quality: 82 });
      const abortSharp = (): void => {
        transformer.destroy(cancelled());
      };
      signal?.addEventListener('abort', abortSharp, { once: true });
      let info: Awaited<ReturnType<typeof transformer.toFile>>;
      try {
        info = await transformer.toFile(processedPath);
      } finally {
        signal?.removeEventListener('abort', abortSharp);
      }
      if (isAborted(signal)) {
        throw cancelled();
      }
      if (
        info.width < 1
        || info.height < 1
        || info.width > VISION_MAX_IMAGE_EDGE
        || info.height > VISION_MAX_IMAGE_EDGE
      ) {
        throw invalidImage();
      }

      await removeFileIfPresent(rawPath);
      return {
        path: processedPath,
        mimeType: 'image/webp',
        byteLength: info.size,
        sourceByteLength,
        width: info.width,
        height: info.height,
      };
    } catch (error) {
      await Promise.allSettled([
        removeFileIfPresent(rawPath),
        removeFileIfPresent(processedPath),
      ]);
      if (error instanceof AppError) {
        throw error;
      }
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'FST_REQ_FILE_TOO_LARGE'
      ) {
        throw new AppError(
          'image_too_large',
          '图片不能超过 10 MiB',
          413,
        );
      }
      if (isAborted(signal) || isAbortError(error)) {
        throw cancelled();
      }
      throw invalidImage();
    }
  }

  async remove(image: PreparedVisionImage): Promise<void> {
    const candidatePath = resolve(image.path);
    const pathFromTempDirectory = relative(this.#tempDirectory, candidatePath);
    if (
      pathFromTempDirectory.length > 0
      && pathFromTempDirectory !== '..'
      && !pathFromTempDirectory.startsWith(`..${sep}`)
      && !isAbsolute(pathFromTempDirectory)
    ) {
      await removeFileIfPresent(candidatePath);
      return;
    }
    throw new TypeError('Prepared image path is outside the vision temp directory');
  }
}
