import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { recipeImportSchema } from '@xiaochu/shared';

interface Options { readonly input: string; readonly output: string; readonly probe: boolean; }
interface Item { readonly sourceKey: string; readonly url: string; readonly kind: string; readonly status: 'unchecked' | 'healthy' | 'unavailable'; }

const option = (name: string, fallback?: string): string => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
};

const parseOptions = (): Options => ({
  input: resolve(option('--input', 'content/canonical/recipes.jsonl')),
  output: resolve(option('--output', 'content/reports/video-health.json')),
  probe: process.argv.includes('--probe'),
});

const probeUrl = async (url: string): Promise<'healthy' | 'unavailable'> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: controller.signal });
    return response.ok ? 'healthy' : 'unavailable';
  } catch {
    return 'unavailable';
  } finally { clearTimeout(timeout); }
};

const main = async (): Promise<void> => {
  const options = parseOptions();
  const items: Item[] = [];
  const lines = createInterface({ input: createReadStream(options.input, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const recipe = recipeImportSchema.parse(JSON.parse(line));
    for (const media of recipe.media) {
      if (media.kind === 'external') continue;
      items.push({
        sourceKey: recipe.sourceKey, url: media.url, kind: media.kind,
        status: options.probe ? await probeUrl(media.url) : 'unchecked',
      });
    }
  }
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ videos: items.length, healthy: items.filter((item) => item.status === 'healthy').length, probe: options.probe })}\n`);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'video health failed' })}\n`);
  process.exitCode = 1;
});
