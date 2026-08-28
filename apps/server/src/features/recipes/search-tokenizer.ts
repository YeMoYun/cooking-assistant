const PUNCTUATION_SYMBOL_OR_SPACE = /[\p{P}\p{S}\s]+/gu;
const HAN_SEQUENCE = /\p{Script=Han}+/gu;
const NON_HAN_SEQUENCE = /[^\p{Script=Han}\s]+/gu;

/** Normalizes width, case, punctuation, and whitespace without losing word boundaries. */
export const normalizeSearchText = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(PUNCTUATION_SYMBOL_OR_SPACE, ' ')
  .trim();

/** Stable comparison form used for exact, prefix, and bounded substring boosts. */
export const compactSearchText = (value: string): string => (
  normalizeSearchText(value).replaceAll(' ', '')
);

const addChineseGrams = (terms: Set<string>, sequence: string): void => {
  const characters = [...sequence];
  for (const size of [2, 3] as const) {
    for (let index = 0; index + size <= characters.length; index += 1) {
      terms.add(characters.slice(index, index + size).join(''));
    }
  }
};

/** Produces deterministic semantic terms plus Chinese 2/3-character grams for FTS5. */
export const buildSearchTerms = (values: readonly string[]): string => {
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSearchText(value);
    const compact = normalized.replaceAll(' ', '');
    if (compact.length === 0) {
      continue;
    }

    terms.add(compact);
    for (const word of normalized.split(' ')) {
      if (word.length > 0) {
        terms.add(word);
      }
    }
    for (const sequence of normalized.match(HAN_SEQUENCE) ?? []) {
      addChineseGrams(terms, sequence);
    }
  }

  return [...terms].sort().join(' ');
};

const quoteFtsTerm = (term: string): string => (
  `"${term.replaceAll('"', '""')}"`
);

/**
 * Builds FTS syntax only from normalized generated tokens. The returned expression
 * must still be passed to SQLite as a bound parameter.
 */
export const buildFtsMatchExpression = (value: string): string => {
  const normalized = normalizeSearchText(value);
  const terms = new Set<string>();

  for (const sequence of normalized.match(HAN_SEQUENCE) ?? []) {
    const characters = [...sequence];
    if (characters.length < 3) {
      terms.add(sequence);
      continue;
    }
    for (let index = 0; index + 3 <= characters.length; index += 1) {
      terms.add(characters.slice(index, index + 3).join(''));
    }
  }
  for (const sequence of normalized.match(NON_HAN_SEQUENCE) ?? []) {
    const compact = sequence.replaceAll(' ', '');
    if (compact.length > 0) {
      terms.add(compact);
    }
  }

  return [...terms].sort().map(quoteFtsTerm).join(' AND ');
};

export const searchTextLength = (value: string): number => (
  [...compactSearchText(value)].length
);
