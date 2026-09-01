import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { normalizeUnit, recipeImportSchema, type RecipeImport, type Unit } from '@xiaochu/shared';
import {
  createConfiguredModelStepEnricher,
  needsModelEnrichment,
  type ModelStepEnricher,
} from './model-step-enricher.js';
import { enrichRecipeStep, type StepEnrichmentInput } from './step-enricher.js';
import { readCoverManifest } from './cover-manifest.js';

interface SourceIngredient { readonly name?: unknown; readonly weight?: unknown; }
interface SourceInstruction { readonly description?: unknown; readonly imgLink?: unknown; }
interface SourceRecipe {
  readonly recipeID?: unknown;
  readonly recipeName?: unknown;
  readonly briefDes?: unknown;
  readonly ingredients?: unknown;
  readonly seasonings?: unknown;
  readonly instructions?: unknown;
  readonly tips?: unknown;
}

const text = (value: unknown, maximum = 2_000): string => typeof value === 'string'
  ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
  : '';

const classify = (name: string): 'produce' | 'meat_egg_dairy' | 'staple' | 'seasoning' | 'other' => {
  if (/(盐|糖|酱|醋|油|料酒|胡椒|花椒|辣椒粉|味精|鸡精|淀粉|葱|姜|蒜)/u.test(name)) return 'seasoning';
  if (/(肉|鸡|鸭|鹅|鱼|虾|蟹|蛋|奶|牛腩|排骨|猪|羊)/u.test(name)) return 'meat_egg_dairy';
  if (/(米|面|粉|豆|馒头|面包|年糕|粉丝)/u.test(name)) return 'staple';
  if (/(菜|瓜|菇|笋|椒|萝卜|番茄|土豆|藕|茄|果|玉米)/u.test(name)) return 'produce';
  return 'other';
};

const unitSuffixes = [
  '千克', '公斤', '毫升', '茶匙', '汤匙', '小勺', '大勺', '适量', '少许',
  '克', '斤', '两', '个', '只', '枚', '根', '片', '瓶', '碗', '勺', 'g', 'kg', 'ml', 'L',
] as const;

const normalizedUnit = (unit: string): Unit => {
  const aliases: Record<string, string> = {
    斤: 'g', 两: 'g', 碗: '适量', 勺: '汤匙', 小勺: '茶匙', 大勺: '汤匙',
  };
  return normalizeUnit(aliases[unit] ?? unit) ?? '适量';
};

const amount = (rawValue: string): { readonly quantity: number; readonly unit: Unit } => {
  const raw = rawValue.replaceAll('约', '').trim();
  if (raw.includes('少许')) return { quantity: 1, unit: '少许' };
  if (raw.includes('适量') || raw === '') return { quantity: 1, unit: '适量' };
  const unit = unitSuffixes.find((candidate) => raw.toLocaleLowerCase('en-US').endsWith(candidate.toLocaleLowerCase('en-US')));
  const numberMatch = /\d+(?:\.\d+)?/u.exec(raw);
  if (unit === undefined || numberMatch === null) return { quantity: 1, unit: '适量' };
  let quantity = Number(numberMatch[0]);
  if (unit === '斤') quantity *= 500;
  if (unit === '两') quantity *= 50;
  return { quantity: quantity > 0 ? quantity : 1, unit: normalizedUnit(unit) };
};

const seasoning = (rawValue: unknown): SourceIngredient | undefined => {
  const raw = text(rawValue, 120);
  if (raw === '') return undefined;
  const suffix = unitSuffixes.find((candidate) => raw.toLocaleLowerCase('en-US').endsWith(candidate.toLocaleLowerCase('en-US')));
  if (suffix === undefined) return { name: raw, weight: '适量' };
  const quantityMatch = new RegExp(`(?:\\d+(?:\\.\\d+)?)?${suffix}$`, 'u').exec(raw);
  const name = quantityMatch === null ? raw : raw.slice(0, quantityMatch.index).trim();
  return name === '' ? undefined : { name, weight: quantityMatch?.[0] ?? suffix };
};

const techniquesFor = (instructions: readonly SourceInstruction[]): string[] => {
  const joined = instructions.map((step) => text(step.description)).join('');
  return ['炒', '蒸', '煮', '炖', '炸', '煎', '烤', '拌']
    .filter((technique) => joined.includes(technique)).slice(0, 5);
};

interface ConversionCounters {
  modelEnriched: number;
  modelFailed: number;
  modelSkipped: number;
}

const convert = async (
  source: SourceRecipe,
  modelEnricher: ModelStepEnricher | undefined,
  counters: ConversionCounters,
  coverUrl: string | undefined,
): Promise<RecipeImport | undefined> => {
  const id = text(source.recipeID, 40);
  const title = text(source.recipeName, 100);
  const instructions = Array.isArray(source.instructions)
    ? source.instructions.filter((value): value is SourceInstruction => typeof value === 'object' && value !== null)
      .filter((step) => text(step.description).length > 0)
    : [];
  const sourceIngredients: SourceIngredient[] = Array.isArray(source.ingredients)
    ? source.ingredients.filter((value): value is SourceIngredient => typeof value === 'object' && value !== null)
    : [];
  if (Array.isArray(source.seasonings)) {
    for (const value of source.seasonings) {
      const parsed = seasoning(value);
      if (parsed !== undefined) sourceIngredients.push(parsed);
    }
  }
  if (id === '' || title === '' || instructions.length === 0 || sourceIngredients.length === 0) return undefined;

  const seenIngredients = new Set<string>();
  const ingredients = sourceIngredients.flatMap((sourceIngredient) => {
    const name = text(sourceIngredient.name, 80);
    const key = name.toLocaleLowerCase('zh-CN');
    if (name === '' || seenIngredients.has(key)) return [];
    seenIngredients.add(key);
    return [{
      canonicalName: name,
      aliases: [],
      category: classify(name),
      ...amount(text(sourceIngredient.weight, 40)),
      optional: false,
    }];
  });
  if (ingredients.length === 0) return undefined;

  const steps = [];
  for (const [index, step] of instructions.entries()) {
    const input: StepEnrichmentInput = {
      instruction: text(step.description),
      number: index + 1,
      ingredients,
      ...(index > 0
        ? { previousInstruction: text(instructions[index - 1]?.description) }
        : {}),
      ...(index + 1 < instructions.length
        ? { nextInstruction: text(instructions[index + 1]?.description) }
        : {}),
    };
    const fallback = enrichRecipeStep(input);
    if (!needsModelEnrichment(input, fallback)) {
      steps.push(fallback);
      continue;
    }
    if (modelEnricher === undefined) {
      counters.modelSkipped += 1;
      steps.push(fallback);
      continue;
    }
    try {
      steps.push(await modelEnricher.enrich(input, fallback));
      counters.modelEnriched += 1;
    } catch {
      counters.modelFailed += 1;
      steps.push(fallback);
    }
  }

  const summary = text(source.briefDes, 500) || `${title}的家常做法，共 ${instructions.length} 个步骤。`;
  const sourceKey = `mirecipe:${id}`;
  const recipe = {
    schemaVersion: 1 as const,
    sourceKey,
    contentVersion: 'mirecipe-rich2',
    title,
    aliases: [],
    summary,
    tier: 'standard' as const,
    difficulty: instructions.length <= 6 ? 'easy' as const : instructions.length <= 10 ? 'medium' as const : 'hard' as const,
    servings: 2,
    prepMinutes: 10,
    cookMinutes: Math.max(5, Math.min(90, instructions.length * 4)),
    taste: [],
    techniques: techniquesFor(instructions),
    tags: ['中文食谱', instructions.length <= 6 ? '步骤较少' : '步骤完整'],
    cover: {
      ...(coverUrl === undefined ? {} : { remoteUrl: coverUrl }),
      alt: `${title}成品图`,
    },
    media: [],
    ingredients,
    steps,
  };
  const parsed = recipeImportSchema.safeParse(recipe);
  return parsed.success ? parsed.data : undefined;
};

const valueFor = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return resolve(index === -1 ? fallback : process.argv[index + 1] ?? fallback);
};

const optionalValueFor = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

const main = async (): Promise<void> => {
  const input = valueFor('--input', 'content/raw/mirecipe/recipeData-new1.json');
  const output = valueFor('--output', 'content/canonical/recipes.jsonl');
  const report = valueFor('--report', 'content/reports/mirecipe-conversion.json');
  const coverManifestPath = valueFor('--cover-manifest', 'content/canonical/recipe-covers.jsonl');
  const coverManifest = await readCoverManifest(coverManifestPath);
  const providerId = optionalValueFor('--provider-id');
  let modelEnricher: ModelStepEnricher | undefined;
  let providerUnavailable = false;
  try {
    modelEnricher = await createConfiguredModelStepEnricher(providerId);
  } catch {
    providerUnavailable = providerId !== undefined;
  }
  const raw: unknown = JSON.parse(await readFile(input, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('MIRecipe root must be an object');
  const recipes: RecipeImport[] = [];
  const counters: ConversionCounters = { modelEnriched: 0, modelFailed: 0, modelSkipped: 0 };
  let rejected = 0;
  try {
    for (const value of Object.values(raw)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) { rejected += 1; continue; }
      const sourceKey = `mirecipe:${text((value as SourceRecipe).recipeID, 40)}`;
      const converted = await convert(
        value as SourceRecipe,
        modelEnricher,
        counters,
        coverManifest.get(sourceKey)?.url,
      );
      if (converted === undefined) rejected += 1;
      else recipes.push(converted);
    }
  } finally {
    modelEnricher?.close();
  }
  if (recipes.length < 10_000) throw new Error(`Only ${recipes.length} valid recipes were produced`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(report), { recursive: true });
  await writeFile(output, `${recipes.map((recipe) => JSON.stringify(recipe)).join('\n')}\n`, 'utf8');
  await writeFile(report, `${JSON.stringify({
    source: 'bimissing/recipeData',
    accepted: recipes.length,
    rejected,
    providerId: providerId ?? null,
    providerUnavailable,
    coversAssigned: recipes.filter((recipe) => recipe.cover.remoteUrl !== undefined).length,
    ...counters,
  }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ accepted: recipes.length, rejected, output, ...counters })}\n`);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'conversion failed' })}\n`);
  process.exitCode = 1;
});
