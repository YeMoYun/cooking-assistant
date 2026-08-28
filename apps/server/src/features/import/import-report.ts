import { randomUUID } from 'node:crypto';

export type ImportMode = 'merge' | 'replace';
export type RecipeTier = 'standard' | 'video' | 'detailed';

export interface ImportErrorEntry {
  readonly line: number;
  readonly sourceKey?: string;
  readonly path: string;
  readonly code: string;
}

export interface ImportReport {
  readonly importId: string;
  readonly mode: ImportMode;
  readonly startedAt: string;
  finishedAt: string;
  accepted: number;
  rejected: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  readonly tierCounts: Record<RecipeTier, number>;
  readonly errors: ImportErrorEntry[];
}

const SAFE_ERROR_TOKEN = /^[A-Za-z0-9_$.[\]-]{1,160}$/u;
const UNSAFE_SOURCE_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export const sanitizeErrorToken = (
  value: string,
  fallback: string,
): string => SAFE_ERROR_TOKEN.test(value) ? value : fallback;

export const sanitizeSourceKey = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (
    normalized.length === 0
    || normalized.length > 200
    || UNSAFE_SOURCE_CHARACTER.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
};

export const createImportReport = (
  mode: ImportMode,
  now = new Date(),
): ImportReport => ({
  importId: randomUUID(),
  mode,
  startedAt: now.toISOString(),
  finishedAt: now.toISOString(),
  accepted: 0,
  rejected: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  deactivated: 0,
  tierCounts: { standard: 0, video: 0, detailed: 0 },
  errors: [],
});

export const appendImportError = (
  report: ImportReport,
  error: ImportErrorEntry,
): void => {
  const sourceKey = sanitizeSourceKey(error.sourceKey);
  report.errors.push({
    line: Number.isSafeInteger(error.line) && error.line > 0 ? error.line : 1,
    ...(sourceKey === undefined ? {} : { sourceKey }),
    path: sanitizeErrorToken(error.path, '$'),
    code: sanitizeErrorToken(error.code, 'invalid_record'),
  });
};

export const finishImportReport = (
  report: ImportReport,
  now = new Date(),
): ImportReport => {
  report.finishedAt = now.toISOString();
  return report;
};
