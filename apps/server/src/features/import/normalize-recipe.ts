import { createHash } from 'node:crypto';
import type { RecipeImport, RecipeMedia } from '@xiaochu/shared';
import {
  buildSearchTerms,
  compactSearchText,
} from '../recipes/search-tokenizer.js';

const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}\s]+/gu;

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  公克: 'g',
  克: 'g',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  公斤: 'kg',
  千克: 'kg',
  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  毫升: 'ml',
  l: 'L',
  liter: 'L',
  liters: 'L',
  公升: 'L',
  升: 'L',
  tsp: '茶匙',
  teaspoon: '茶匙',
  teaspoons: '茶匙',
  小勺: '茶匙',
  茶匙: '茶匙',
  tbsp: '汤匙',
  tablespoon: '汤匙',
  tablespoons: '汤匙',
  大勺: '汤匙',
  汤匙: '汤匙',
  个: '个',
  只: '只',
  片: '片',
  根: '根',
  颗: '颗',
  适量: '适量',
  少许: '少许',
};

export class RecipeNormalizationError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(path: string, code: string) {
    super(code);
    this.name = 'RecipeNormalizationError';
    this.path = path;
    this.code = code;
  }
}

export const normalizeDisplayText = (value: string): string => value
  .normalize('NFKC')
  .replace(/[‘’]/gu, "'")
  .replace(/[“”]/gu, '"')
  .replace(/[‐‑‒–—―]/gu, '-')
  .replace(/\s+/gu, ' ')
  .trim();

export const normalizeLookupText = (value: string): string => normalizeDisplayText(value)
  .toLocaleLowerCase('zh-CN')
  .replace(PUNCTUATION_OR_SYMBOL, ' ')
  .trim();

export const normalizeUnit = (value: string): string => {
  const display = normalizeDisplayText(value);
  const key = display.toLocaleLowerCase('en-US').replace(/[.\s]/gu, '');
  return UNIT_ALIASES[key] ?? display;
};

const digest = (scope: string, identity: string): string => createHash('sha256')
  .update(scope)
  .update('\0')
  .update(identity)
  .digest('hex');

const stableId = (prefix: string, scope: string, identity: string): string => (
  `${prefix}_${digest(scope, identity).slice(0, 32)}`
);

const compareCanonical = (left: string, right: string): number => {
  const leftKey = normalizeLookupText(left);
  const rightKey = normalizeLookupText(right);
  return leftKey.localeCompare(rightKey, 'zh-CN') || left.localeCompare(right, 'zh-CN');
};

const canonicalizeLabels = (values: readonly string[]): string[] => {
  const labels = new Map<string, string>();
  for (const value of values) {
    const display = normalizeDisplayText(value);
    const key = normalizeLookupText(display);
    const existing = labels.get(key);
    if (key.length > 0 && (existing === undefined || display.localeCompare(existing, 'zh-CN') < 0)) {
      labels.set(key, display);
    }
  }
  return [...labels.values()].sort(compareCanonical);
};

export interface NormalizedMedia {
  readonly id: string;
  readonly position: number;
  readonly kind: RecipeMedia['kind'];
  readonly url: string;
  readonly provider: string;
  readonly posterUrl?: string;
}

export interface NormalizedIngredientAlias {
  readonly id: string;
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly position: number;
}

export interface NormalizedIngredient {
  readonly id: string;
  readonly recipeIngredientId: string;
  readonly position: number;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly aliases: readonly NormalizedIngredientAlias[];
  readonly category: RecipeImport['ingredients'][number]['category'];
  readonly quantity: number;
  readonly unit: string;
  readonly optional: boolean;
  readonly note?: string;
}

export interface NormalizedStep {
  readonly id: string;
  readonly number: number;
  readonly instruction: string;
  readonly recipeIngredientIds: readonly string[];
  readonly durationSecondsMin?: number;
  readonly durationSecondsMax?: number;
  readonly heatOrDevice?: string;
  readonly completionCue?: string;
  readonly commonMistake?: string;
  readonly safetyRequirement?: string;
}

export interface NormalizedTag {
  readonly id: string;
  readonly kind: 'tag' | 'taste' | 'technique';
  readonly value: string;
  readonly normalizedValue: string;
  readonly position: number;
}

export interface NormalizedSearchDocument {
  readonly titleNormalized: string;
  readonly aliasesNormalized: string;
  readonly titleTerms: string;
  readonly ingredientTerms: string;
  readonly aliasTerms: string;
  readonly summaryTerms: string;
  readonly tagTerms: string;
}

export interface NormalizedRecipe {
  readonly id: string;
  readonly sourceKey: string;
  readonly contentVersion: string;
  readonly schemaVersion: 1;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly tier: RecipeImport['tier'];
  readonly difficulty: RecipeImport['difficulty'];
  readonly servings: number;
  readonly prepMinutes: number;
  readonly cookMinutes: number;
  readonly taste: readonly string[];
  readonly techniques: readonly string[];
  readonly tags: readonly string[];
  readonly cover: { readonly remoteUrl?: string; readonly alt: string };
  readonly media: readonly NormalizedMedia[];
  readonly ingredients: readonly NormalizedIngredient[];
  readonly steps: readonly NormalizedStep[];
  readonly normalizedTags: readonly NormalizedTag[];
  readonly search: NormalizedSearchDocument;
  readonly contentHash: string;
}

export interface NormalizedRecipePayload {
  readonly recipe: NormalizedRecipe;
  readonly canonicalJson: string;
}

/** Converts a schema-valid recipe into deterministic persistence/search data. */
export const normalizeRecipe = (input: RecipeImport): NormalizedRecipePayload => {
  const sourceKey = normalizeLookupText(input.sourceKey);
  if (sourceKey.length === 0) {
    throw new RecipeNormalizationError('sourceKey', 'empty_normalized_source_key');
  }
  const recipeId = stableId('recipe', 'recipe-source-key', sourceKey);
  const aliases = canonicalizeLabels(input.aliases);
  const taste = canonicalizeLabels(input.taste);
  const techniques = canonicalizeLabels(input.techniques);
  const tags = canonicalizeLabels(input.tags);
  const ingredientReference = new Map<string, string>();

  const ingredients = input.ingredients.map((ingredient, position): NormalizedIngredient => {
    const canonicalName = normalizeDisplayText(ingredient.canonicalName);
    const normalizedName = normalizeLookupText(canonicalName);
    if (normalizedName.length === 0) {
      throw new RecipeNormalizationError(
        `ingredients[${position}].canonicalName`,
        'empty_normalized_ingredient_name',
      );
    }
    const ingredientId = stableId('ingredient', 'ingredient-name', normalizedName);
    const recipeIngredientId = stableId(
      'recipe_ingredient',
      recipeId,
      normalizedName,
    );
    const aliasValues = canonicalizeLabels(ingredient.aliases)
      .filter((alias) => normalizeLookupText(alias) !== normalizedName);
    const names = [canonicalName, ...aliasValues];
    for (const [nameIndex, name] of names.entries()) {
      const key = normalizeLookupText(name);
      const owner = ingredientReference.get(key);
      if (owner !== undefined && owner !== recipeIngredientId) {
        throw new RecipeNormalizationError(
          `ingredients[${position}]${nameIndex === 0 ? '.canonicalName' : `.aliases[${nameIndex - 1}]`}`,
          'ingredient_name_collision',
        );
      }
      ingredientReference.set(key, recipeIngredientId);
    }
    const normalizedAliases = aliasValues.map((alias, aliasPosition) => {
      const normalizedAlias = normalizeLookupText(alias);
      return {
        id: stableId('ingredient_alias', ingredientId, normalizedAlias),
        alias,
        normalizedAlias,
        position: aliasPosition,
      };
    });
    return {
      id: ingredientId,
      recipeIngredientId,
      position,
      canonicalName,
      normalizedName,
      aliases: normalizedAliases,
      category: ingredient.category,
      quantity: ingredient.quantity,
      unit: normalizeUnit(ingredient.unit),
      optional: ingredient.optional,
      ...(ingredient.note === undefined ? {} : { note: normalizeDisplayText(ingredient.note) }),
    };
  });

  const media = input.media.map((item, position): NormalizedMedia => {
    const provider = normalizeLookupText(item.provider);
    const identity = `${item.kind}\0${provider}\0${item.url}`;
    return {
      id: stableId('recipe_media', recipeId, identity),
      position,
      kind: item.kind,
      url: item.url,
      provider,
      ...(item.posterUrl === undefined ? {} : { posterUrl: item.posterUrl }),
    };
  });

  const steps = input.steps.map((step): NormalizedStep => {
    const references = step.ingredientNames.map((name, referenceIndex) => {
      const reference = ingredientReference.get(normalizeLookupText(name));
      if (reference === undefined) {
        throw new RecipeNormalizationError(
          `steps[${step.number - 1}].ingredientNames[${referenceIndex}]`,
          'unresolved_ingredient_reference',
        );
      }
      return reference;
    });
    return {
      id: stableId('recipe_step', recipeId, String(step.number)),
      number: step.number,
      instruction: normalizeDisplayText(step.instruction),
      recipeIngredientIds: references,
      ...(step.durationSecondsMin === undefined ? {} : {
        durationSecondsMin: step.durationSecondsMin,
        durationSecondsMax: step.durationSecondsMax as number,
      }),
      ...(step.heatOrDevice === undefined ? {} : { heatOrDevice: normalizeDisplayText(step.heatOrDevice) }),
      ...(step.completionCue === undefined ? {} : { completionCue: normalizeDisplayText(step.completionCue) }),
      ...(step.commonMistake === undefined ? {} : { commonMistake: normalizeDisplayText(step.commonMistake) }),
      ...(step.safetyRequirement === undefined ? {} : { safetyRequirement: normalizeDisplayText(step.safetyRequirement) }),
    };
  });

  const normalizedTags: NormalizedTag[] = [];
  for (const [kind, values] of [
    ['tag', tags],
    ['taste', taste],
    ['technique', techniques],
  ] as const) {
    values.forEach((value, position) => {
      const normalizedValue = normalizeLookupText(value);
      normalizedTags.push({
        id: stableId('recipe_tag', recipeId, `${kind}\0${normalizedValue}`),
        kind,
        value,
        normalizedValue,
        position,
      });
    });
  }

  const title = normalizeDisplayText(input.title);
  const summary = normalizeDisplayText(input.summary);
  const ingredientNames = ingredients.flatMap((ingredient) => [
    ingredient.canonicalName,
    ...ingredient.aliases.map((alias) => alias.alias),
  ]);
  const search: NormalizedSearchDocument = {
    titleNormalized: compactSearchText(title),
    aliasesNormalized: aliases.map(compactSearchText).join(' '),
    titleTerms: buildSearchTerms([title]),
    ingredientTerms: buildSearchTerms(ingredientNames),
    aliasTerms: buildSearchTerms(aliases),
    summaryTerms: buildSearchTerms([summary]),
    tagTerms: buildSearchTerms([...tags, ...taste, ...techniques]),
  };
  const searchLimits: ReadonlyArray<readonly [keyof NormalizedSearchDocument, number]> = [
    ['titleNormalized', 200],
    ['aliasesNormalized', 4000],
    ['titleTerms', 8000],
    ['ingredientTerms', 16000],
    ['aliasTerms', 12000],
    ['summaryTerms', 16000],
    ['tagTerms', 12000],
  ];
  for (const [field, limit] of searchLimits) {
    if (search[field].length > limit) {
      throw new RecipeNormalizationError(field, 'search_document_too_large');
    }
  }

  const identity = {
    sourceKey,
    contentVersion: normalizeDisplayText(input.contentVersion),
    schemaVersion: 1 as const,
    title,
    aliases,
    summary,
    tier: input.tier,
    difficulty: input.difficulty,
    servings: input.servings,
    prepMinutes: input.prepMinutes,
    cookMinutes: input.cookMinutes,
    taste,
    techniques,
    tags,
    cover: {
      ...(input.cover.remoteUrl === undefined ? {} : { remoteUrl: input.cover.remoteUrl }),
      alt: normalizeDisplayText(input.cover.alt),
    },
    media,
    ingredients,
    steps,
    normalizedTags,
    search,
  };
  const contentHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const recipe: NormalizedRecipe = { id: recipeId, ...identity, contentHash };
  return { recipe, canonicalJson: JSON.stringify(recipe) };
};
