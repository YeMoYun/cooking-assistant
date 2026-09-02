import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';

export const coverManifestRowSchema = z.object({
  sourceKey: z.string().min(1).max(200),
  title: z.string().min(1).max(100),
  url: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
  source: z.enum(['mirecipe', 'mirecipe-title-match', 'bing', 'openverse']),
  matchedTerms: z.array(z.string().min(1).max(80)).min(1).max(10),
  checkedAt: z.string().datetime({ offset: true }),
}).strict();

export type CoverManifestRow = z.infer<typeof coverManifestRowSchema>;

export const createSerializedCoverManifestWriter = <T>(
  writeSnapshot: (rows: readonly T[]) => Promise<void>,
): ((rows: Iterable<T>) => Promise<void>) => {
  let tail: Promise<void> = Promise.resolve();
  return (rows: Iterable<T>): Promise<void> => {
    const snapshot = [...rows];
    const write = tail.then(() => writeSnapshot(snapshot));
    tail = write.catch(() => undefined);
    return write;
  };
};

const RETIRED_COVER_HOSTS = new Set(['res.hoto.cn', 'res1.hoto.cn']);

export const isRetiredCoverUrl = (value: string): boolean => {
  try {
    return RETIRED_COVER_HOSTS.has(new URL(value).hostname.toLocaleLowerCase('en-US'));
  } catch {
    return true;
  }
};

export const readCoverManifest = async (
  filePath: string,
): Promise<Map<string, CoverManifestRow>> => {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const rows = new Map<string, CoverManifestRow>();
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue;
    const row = coverManifestRowSchema.parse(JSON.parse(line));
    rows.set(row.sourceKey, row);
  }
  return rows;
};

export const writeCoverManifest = async (
  filePath: string,
  rows: Iterable<CoverManifestRow>,
): Promise<void> => {
  const sorted = [...rows].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey, 'zh-CN'));
  const output = `${sorted.map((row) => JSON.stringify(coverManifestRowSchema.parse(row))).join('\n')}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`);
  await writeFile(temporary, output, 'utf8');
  await rename(temporary, filePath);
};
