import { createReadStream } from 'node:fs';

export type JsonlBlankLinePolicy = 'skip' | 'reject';

export interface JsonlReadOptions {
  readonly maximumLineBytes?: number;
  readonly blankLinePolicy?: JsonlBlankLinePolicy;
}

export type JsonlReadResult =
  | { readonly line: number; readonly value: unknown }
  | {
    readonly line: number;
    readonly error: { readonly path: '$'; readonly code: string };
  };

const DEFAULT_MAXIMUM_LINE_BYTES = 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const decodeLine = (bytes: Buffer, line: number): JsonlReadResult | undefined => {
  let content = bytes;
  if (line === 1 && content.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    content = content.subarray(UTF8_BOM.length);
  }
  if (content.at(-1) === 0x0d) {
    content = content.subarray(0, -1);
  }
  let text: string;
  try {
    text = utf8Decoder.decode(content);
  } catch {
    return { line, error: { path: '$', code: 'invalid_utf8' } };
  }
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return { line, value: JSON.parse(text) as unknown };
  } catch {
    return { line, error: { path: '$', code: 'invalid_json' } };
  }
};

/** Streams JSONL without retaining a whole file or exposing source text in errors. */
export async function* readJsonl(
  filePath: string,
  options: JsonlReadOptions = {},
): AsyncGenerator<JsonlReadResult> {
  const maximumLineBytes = options.maximumLineBytes ?? DEFAULT_MAXIMUM_LINE_BYTES;
  if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1) {
    throw new RangeError('maximumLineBytes must be a positive safe integer');
  }
  const blankLinePolicy = options.blankLinePolicy ?? 'skip';
  let pending = Buffer.alloc(0);
  let discardingOversizedLine = false;
  let line = 1;

  for await (const chunkValue of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    let offset = 0;
    while (offset < chunk.length) {
      if (discardingOversizedLine) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline === -1) {
          offset = chunk.length;
          continue;
        }
        discardingOversizedLine = false;
        line += 1;
        offset = newline + 1;
        continue;
      }

      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (pending.length + segment.length > maximumLineBytes) {
        pending = Buffer.alloc(0);
        yield { line, error: { path: '$', code: 'jsonl_line_too_large' } };
        if (newline === -1) {
          discardingOversizedLine = true;
          offset = chunk.length;
        } else {
          line += 1;
          offset = newline + 1;
        }
        continue;
      }
      pending = pending.length === 0
        ? Buffer.from(segment)
        : Buffer.concat([pending, segment], pending.length + segment.length);
      if (newline === -1) {
        offset = chunk.length;
        continue;
      }

      const parsed = decodeLine(pending, line);
      if (parsed !== undefined) {
        yield parsed;
      } else if (blankLinePolicy === 'reject') {
        yield { line, error: { path: '$', code: 'blank_line' } };
      }
      pending = Buffer.alloc(0);
      line += 1;
      offset = newline + 1;
    }
  }

  if (!discardingOversizedLine && pending.length > 0) {
    const parsed = decodeLine(pending, line);
    if (parsed !== undefined) {
      yield parsed;
    } else if (blankLinePolicy === 'reject') {
      yield { line, error: { path: '$', code: 'blank_line' } };
    }
  }
}
