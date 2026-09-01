import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { request } from 'undici';
import sharp from 'sharp';
import {
  OutboundUrlPolicy,
  type ResolvedAddress,
} from '../../apps/server/src/features/providers/outbound-url-policy.js';
import { createSafeDispatcher } from '../../apps/server/src/features/providers/safe-dispatcher.js';
import {
  readCoverManifest,
  writeCoverManifest,
  type CoverManifestRow,
} from './cover-manifest.js';

interface SourceInstruction { readonly description?: unknown; readonly imgLink?: unknown; }
interface SourceRecipe {
  readonly recipeID?: unknown;
  readonly recipeName?: unknown;
  readonly instructions?: unknown;
}

interface CanonicalRecipe {
  readonly sourceKey: string;
  readonly title: string;
  readonly ingredientNames: readonly string[];
}

interface PhotoRecipe extends CanonicalRecipe {
  readonly url: string;
}

interface SearchResult {
  readonly url: string;
  readonly source: 'bing' | 'openverse';
}

const IMAGE_MAX_BYTES = 8 * 1_024 * 1_024;
const SEARCH_MAX_BYTES = 2 * 1_024 * 1_024;
const USER_AGENT = 'XiaoChuLocal/0.1 (local recipe cover indexer)';

const text = (value: unknown, maximum = 2_000): string => typeof value === 'string'
  ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
  : '';

const normalizeTitle = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}\s]/gu, '');

const normalizeImageUrl = (value: unknown): string | undefined => {
  const raw = text(value, 4_096);
  if (raw === '') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && (url.hostname === 'res.hoto.cn' || url.hostname === 'res1.hoto.cn')) {
      url.protocol = 'https:';
    }
    url.hash = '';
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const valueFor = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return resolve(index === -1 ? fallback : process.argv[index + 1] ?? fallback);
};

const numberFor = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(name);
  const raw = index === -1 ? undefined : process.argv[index + 1];
  const parsed = raw === undefined ? fallback : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const loadCanonicalRecipes = async (filePath: string): Promise<CanonicalRecipe[]> => {
  const contents = await readFile(filePath, 'utf8');
  return contents.split(/\r?\n/u).flatMap((line) => {
    if (line.trim() === '') return [];
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const sourceKey = text(record.sourceKey, 200);
    const title = text(record.title, 100);
    if (sourceKey === '' || title === '') return [];
    const ingredients = Array.isArray(record.ingredients) ? record.ingredients : [];
    const ingredientNames = ingredients.flatMap((ingredient) => {
      if (typeof ingredient !== 'object' || ingredient === null) return [];
      const name = text((ingredient as Record<string, unknown>).canonicalName, 80);
      return name === '' ? [] : [name];
    });
    return [{ sourceKey, title, ingredientNames }];
  });
};

const loadSourceRecipes = async (filePath: string): Promise<Map<string, SourceRecipe>> => {
  const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MIRecipe root must be an object');
  }
  const recipes = new Map<string, SourceRecipe>();
  for (const raw of Object.values(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const source = raw as SourceRecipe;
    const id = text(source.recipeID, 40);
    if (id !== '') recipes.set(`mirecipe:${id}`, source);
  }
  return recipes;
};

const lastPhoto = (source: SourceRecipe | undefined): string | undefined => {
  if (!Array.isArray(source?.instructions)) return undefined;
  const urls = source.instructions.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const url = normalizeImageUrl((value as SourceInstruction).imgLink);
    return url === undefined ? [] : [url];
  });
  return urls.at(-1);
};

const dnsCache = new Map<string, Promise<readonly ResolvedAddress[]>>();
const policy = new OutboundUrlPolicy({
  resolveHost: async (hostname) => {
    let pending = dnsCache.get(hostname);
    if (pending === undefined) {
      pending = dnsLookup(hostname, { all: true, order: 'verbatim' }).then((addresses) => (
        addresses.flatMap((address) => address.family === 4 || address.family === 6
          ? [{ address: address.address, family: address.family }]
          : [])
      ));
      dnsCache.set(hostname, pending);
    }
    return pending;
  },
});

const readBounded = async (
  url: string,
  maximumBytes: number,
  accept: string,
): Promise<{ readonly body: Buffer; readonly contentType: string; readonly finalUrl: string }> => {
  let current = url;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const validated = await policy.validateResourceUrl(current);
    const safeDispatcher = createSafeDispatcher({
      boundOrigin: validated.origin,
      developmentLoopback: false,
      policy,
      targetUrl: validated.normalizedUrl,
      connectTimeoutMs: 8_000,
    });
    try {
      const response = await request(validated.normalizedUrl, {
        method: 'GET',
        headers: { accept, 'user-agent': USER_AGENT },
        bodyTimeout: 20_000,
        headersTimeout: 15_000,
        dispatcher: safeDispatcher.dispatcher,
      });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        await response.body.dump();
        if (typeof location !== 'string' || redirect === 3) throw new Error('Redirect target is invalid');
        current = new URL(location, validated.normalizedUrl).toString();
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump();
        throw new Error(`HTTP ${response.statusCode}`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maximumBytes) throw new Error('Response is too large');
        chunks.push(buffer);
      }
      return {
        body: Buffer.concat(chunks, total),
        contentType: String(response.headers['content-type'] ?? '').toLocaleLowerCase('en-US'),
        finalUrl: validated.normalizedUrl,
      };
    } finally {
      await safeDispatcher.close().catch(() => undefined);
    }
  }
  throw new Error('Too many redirects');
};

const decodeHtml = (value: string): string => value
  .replaceAll('&amp;', '&')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>');

const bingCandidates = async (query: string): Promise<string[]> => {
  const url = new URL('https://www.bing.com/images/search');
  url.searchParams.set('q', query);
  url.searchParams.set('form', 'HDRSC2');
  url.searchParams.set('first', '1');
  const response = await readBounded(url.toString(), SEARCH_MAX_BYTES, 'text/html,application/xhtml+xml');
  const html = response.body.toString('utf8');
  const encoded = [...html.matchAll(/murl&quot;:&quot;(?<url>https?:\/\/.*?)(?:&quot;)/gu)]
    .map((match) => decodeHtml(match.groups?.url ?? ''));
  const plain = [...decodeHtml(html).matchAll(/"murl"\s*:\s*"(?<url>https?:\\?\/\\?\/.*?)(?<!\\)"/gu)]
    .map((match) => (match.groups?.url ?? '').replaceAll('\\/', '/'));
  return [...new Set([...encoded, ...plain])];
};

interface OpenverseResponse {
  readonly results?: readonly { readonly url?: unknown; readonly thumbnail?: unknown }[];
}

const openverseCandidates = async (query: string): Promise<string[]> => {
  const url = new URL('https://api.openverse.org/v1/images/');
  url.searchParams.set('q', query);
  url.searchParams.set('page_size', '10');
  url.searchParams.set('mature', 'false');
  const response = await readBounded(url.toString(), SEARCH_MAX_BYTES, 'application/json');
  const parsed = JSON.parse(response.body.toString('utf8')) as OpenverseResponse;
  return [...new Set((parsed.results ?? []).flatMap((result) => [result.url, result.thumbnail])
    .flatMap((candidate) => {
      const normalized = normalizeImageUrl(candidate);
      return normalized === undefined ? [] : [normalized];
    }))];
};

const validateImage = async (candidate: string): Promise<string | undefined> => {
  try {
    const response = await readBounded(candidate, IMAGE_MAX_BYTES, 'image/avif,image/webp,image/jpeg,image/png,image/*');
    if (!response.contentType.startsWith('image/')) return undefined;
    const metadata = await sharp(response.body, { failOn: 'warning' }).metadata();
    if ((metadata.width ?? 0) < 480 || (metadata.height ?? 0) < 320) return undefined;
    if (metadata.format === 'svg') return undefined;
    return response.finalUrl;
  } catch {
    return undefined;
  }
};

const searchForCover = async (recipe: CanonicalRecipe): Promise<SearchResult | undefined> => {
  const terms = [recipe.title, ...recipe.ingredientNames.slice(0, 3)];
  const query = `${terms.join(' ')} 菜品 成品图`;
  for (const candidate of await bingCandidates(query).catch(() => [])) {
    const validated = await validateImage(candidate);
    if (validated !== undefined) return { url: validated, source: 'bing' };
  }
  for (const candidate of await openverseCandidates(`${recipe.title} Chinese food dish`).catch(() => [])) {
    const validated = await validateImage(candidate);
    if (validated !== undefined) return { url: validated, source: 'openverse' };
  }
  return undefined;
};

const bigrams = (value: string): Set<string> => {
  const normalized = normalizeTitle(value);
  if (normalized.length <= 1) return new Set([normalized]);
  return new Set([...normalized].slice(0, -1).map((character, index) => `${character}${normalized[index + 1] ?? ''}`));
};

const intersectionSize = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  let total = 0;
  for (const value of left) if (right.has(value)) total += 1;
  return total;
};

const closestPhoto = (recipe: CanonicalRecipe, candidates: readonly PhotoRecipe[]): PhotoRecipe => {
  const titleTerms = bigrams(recipe.title);
  const ingredients = new Set(recipe.ingredientNames.map(normalizeTitle));
  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateTerms = bigrams(candidate.title);
    const titleOverlap = intersectionSize(titleTerms, candidateTerms);
    const ingredientOverlap = intersectionSize(
      ingredients,
      new Set(candidate.ingredientNames.map(normalizeTitle)),
    );
    const score = ingredientOverlap * 12 + titleOverlap * 4
      - Math.abs(normalizeTitle(recipe.title).length - normalizeTitle(candidate.title).length);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (best === undefined) throw new Error('No photo-backed recipe is available');
  return best;
};

const main = async (): Promise<void> => {
  const input = valueFor('--input', 'content/raw/mirecipe/recipeData-new1.json');
  const catalog = valueFor('--catalog', 'content/canonical/recipes.jsonl');
  const output = valueFor('--output', 'content/canonical/recipe-covers.jsonl');
  const concurrency = numberFor('--concurrency', 6);
  const canonical = await loadCanonicalRecipes(catalog);
  if (canonical.length !== 10_520) throw new Error(`Expected 10520 canonical recipes, received ${canonical.length}`);
  const sourceRecipes = await loadSourceRecipes(input);
  const allowlist = new Set(canonical.map((recipe) => recipe.sourceKey));
  const manifest = new Map(
    [...(await readCoverManifest(output))].filter(([sourceKey]) => allowlist.has(sourceKey)),
  );
  const photos: PhotoRecipe[] = [];
  const photosByTitle = new Map<string, PhotoRecipe>();
  const checkedAt = new Date().toISOString();

  for (const recipe of canonical) {
    const url = lastPhoto(sourceRecipes.get(recipe.sourceKey));
    if (url === undefined) continue;
    const photo = { ...recipe, url };
    photos.push(photo);
    if (!photosByTitle.has(normalizeTitle(recipe.title))) photosByTitle.set(normalizeTitle(recipe.title), photo);
    if (!manifest.has(recipe.sourceKey)) {
      manifest.set(recipe.sourceKey, {
        sourceKey: recipe.sourceKey,
        title: recipe.title,
        url,
        source: 'mirecipe',
        matchedTerms: [recipe.title],
        checkedAt,
      });
    }
  }

  for (const recipe of canonical) {
    if (manifest.has(recipe.sourceKey)) continue;
    const matched = photosByTitle.get(normalizeTitle(recipe.title));
    if (matched === undefined) continue;
    manifest.set(recipe.sourceKey, {
      sourceKey: recipe.sourceKey,
      title: recipe.title,
      url: matched.url,
      source: 'mirecipe-title-match',
      matchedTerms: [recipe.title],
      checkedAt,
    });
  }
  await writeCoverManifest(output, manifest.values());

  const pending = canonical.filter((recipe) => !manifest.has(recipe.sourceKey));
  let cursor = 0;
  let searched = 0;
  let searchMatched = 0;
  let semanticFallback = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const recipe = pending[index];
      if (recipe === undefined) return;
      const searchedCover = await searchForCover(recipe);
      searched += 1;
      if (searchedCover !== undefined) {
        manifest.set(recipe.sourceKey, {
          sourceKey: recipe.sourceKey,
          title: recipe.title,
          url: searchedCover.url,
          source: searchedCover.source,
          matchedTerms: [recipe.title, ...recipe.ingredientNames.slice(0, 3)],
          checkedAt: new Date().toISOString(),
        });
        searchMatched += 1;
      } else {
        const closest = closestPhoto(recipe, photos);
        manifest.set(recipe.sourceKey, {
          sourceKey: recipe.sourceKey,
          title: recipe.title,
          url: closest.url,
          source: 'mirecipe-title-match',
          matchedTerms: [closest.title, ...recipe.ingredientNames.slice(0, 3)],
          checkedAt: new Date().toISOString(),
        });
        semanticFallback += 1;
      }
      if (searched % 10 === 0 || searched === pending.length) {
        await writeCoverManifest(output, manifest.values());
        process.stdout.write(`${JSON.stringify({ searched, pending: pending.length, searchMatched, semanticFallback })}\n`);
      }
    }
  });
  await Promise.all(workers);
  await writeCoverManifest(output, manifest.values());
  if (manifest.size !== canonical.length) throw new Error(`Cover manifest is incomplete: ${manifest.size}/${canonical.length}`);
  process.stdout.write(`${JSON.stringify({ recipes: canonical.length, covers: manifest.size, searched, searchMatched, semanticFallback, output })}\n`);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'cover manifest failed' })}\n`);
  process.exitCode = 1;
});

