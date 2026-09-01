import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { recipeImportSchema } from '@xiaochu/shared';

interface Options {
  readonly input: string;
  readonly minimumRecipes: number;
  readonly minimumVideos: number;
  readonly minimumDetailed: number;
  readonly minimumCovers: number;
  readonly minimumGuidedSteps: number;
}

interface Counts {
  recipes: number;
  videos: number;
  detailed: number;
  covers: number;
  steps: number;
  guidedSteps: number;
  invalid: number;
}

const argument = (name: string, fallback?: string): string => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
};

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
  return parsed;
};

const parseOptions = (): Options => ({
  input: resolve(argument('--input', 'content/canonical/recipes.jsonl')),
  minimumRecipes: positiveInteger(argument('--min-recipes', '1'), '--min-recipes'),
  minimumVideos: positiveInteger(argument('--min-videos', '0'), '--min-videos'),
  minimumDetailed: positiveInteger(argument('--min-detailed', '0'), '--min-detailed'),
  minimumCovers: positiveInteger(argument('--min-covers', '0'), '--min-covers'),
  minimumGuidedSteps: positiveInteger(argument('--min-guided-steps', '0'), '--min-guided-steps'),
});

const main = async (): Promise<void> => {
  const options = parseOptions();
  await stat(options.input);
  const ids = new Set<string>();
  const counts: Counts = {
    recipes: 0,
    videos: 0,
    detailed: 0,
    covers: 0,
    steps: 0,
    guidedSteps: 0,
    invalid: 0,
  };
  const input = createInterface({ input: createReadStream(options.input, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of input) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    try {
      const recipe = recipeImportSchema.parse(JSON.parse(line));
      if (ids.has(recipe.sourceKey)) throw new Error('Duplicate sourceKey');
      ids.add(recipe.sourceKey);
      counts.recipes += 1;
      if (recipe.cover.remoteUrl !== undefined) counts.covers += 1;
      counts.steps += recipe.steps.length;
      counts.guidedSteps += recipe.steps.filter((step) => (
        step.durationSecondsMin > 0
        && step.durationSecondsMax >= step.durationSecondsMin
        && step.heatOrDevice.length > 0
        && step.completionCue.length > 0
        && step.commonMistake.length > 0
        && step.safetyRequirement.length > 0
      )).length;
      if (recipe.media.some((media) => media.kind === 'html5' || media.kind === 'iframe')) counts.videos += 1;
      if (recipe.tier === 'detailed') counts.detailed += 1;
    } catch (error) {
      counts.invalid += 1;
      process.stderr.write(`Invalid recipe at line ${lineNumber}: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    }
  }
  const passes = counts.invalid === 0
    && counts.recipes >= options.minimumRecipes
    && counts.videos >= options.minimumVideos
    && counts.detailed >= options.minimumDetailed
    && counts.covers >= options.minimumCovers
    && counts.guidedSteps >= options.minimumGuidedSteps;
  process.stdout.write(`${JSON.stringify({ ...counts, passes })}\n`);
  if (!passes) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'validation failed' })}\n`);
  process.exitCode = 1;
});
