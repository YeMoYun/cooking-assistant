import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { recipeImportSchema, recipeMediaSchema, type RecipeImport, type RecipeMedia } from '@xiaochu/shared';
import { z } from 'zod';

const manifestRowSchema = z.object({
  sourceKey: z.string().min(1).max(200),
  media: recipeMediaSchema,
}).strict();

const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return resolve(index === -1 ? fallback : process.argv[index + 1] ?? fallback);
};

const minimum = (): number => {
  const index = process.argv.indexOf('--min-videos');
  const value = Number(index === -1 ? '1' : process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid --min-videos');
  return value;
};

const readJsonLines = async <T>(path: string, parse: (value: unknown) => T): Promise<T[]> => {
  const result: T[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() !== '') result.push(parse(JSON.parse(line)));
  }
  return result;
};

const mediaIdentity = (media: RecipeMedia): string => `${media.kind}:${media.url}`;

const main = async (): Promise<void> => {
  const recipesPath = argument('--recipes', 'content/canonical/recipes.jsonl');
  const manifestPath = argument('--manifest', 'content/canonical/video-manifest.jsonl');
  const outputPath = argument('--output', 'content/canonical/recipes-with-video.jsonl');
  const minimumVideos = minimum();
  const recipes = await readJsonLines(recipesPath, (value) => recipeImportSchema.parse(value));
  const manifest = await readJsonLines(manifestPath, (value) => manifestRowSchema.parse(value));
  const bySourceKey = new Map(recipes.map((recipe) => [recipe.sourceKey, recipe]));
  const manifestKeys = new Set<string>();
  for (const row of manifest) {
    if (manifestKeys.has(row.sourceKey)) throw new Error(`Duplicate video manifest sourceKey: ${row.sourceKey}`);
    manifestKeys.add(row.sourceKey);
    const recipe = bySourceKey.get(row.sourceKey);
    if (recipe === undefined) throw new Error(`Video recipe does not exist: ${row.sourceKey}`);
    const media = recipe.media.some((existing) => mediaIdentity(existing) === mediaIdentity(row.media))
      ? recipe.media : [...recipe.media, row.media];
    bySourceKey.set(row.sourceKey, recipeImportSchema.parse({
      ...recipe,
      tier: recipe.tier === 'detailed' ? 'detailed' : 'video',
      media,
    }));
  }
  const output = recipes.map((recipe) => bySourceKey.get(recipe.sourceKey) as RecipeImport);
  const videoCount = output.filter((recipe) => recipe.media.some((media) => media.kind === 'html5' || media.kind === 'iframe')).length;
  if (videoCount < minimumVideos) throw new Error(`Only ${videoCount} recipes have playable media; expected ${minimumVideos}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${output.map((recipe) => JSON.stringify(recipe)).join('\n')}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ recipes: output.length, videoRecipes: videoCount, output: outputPath })}\n`);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'video manifest failed' })}\n`);
  process.exitCode = 1;
});
