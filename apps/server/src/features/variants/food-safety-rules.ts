import type {
  RecipeVariant,
  RecipeVariantPreviewInput,
} from '@xiaochu/shared';
import type { VariantSourceRecipe } from './variant-types.js';

export const FOOD_SAFETY_RULESET_VERSION = 'food-safety-rules/1';

export type FoodSafetyCategory =
  | 'poultry'
  | 'ground_meat'
  | 'whole_cut'
  | 'seafood'
  | 'egg'
  | 'leftovers';

export interface FoodSafetyIssue {
  readonly code:
    | 'unsafe_raw_request'
    | 'missing_safety_requirement'
    | 'unsafe_safety_instruction'
    | 'insufficient_internal_temperature';
  readonly ingredientName?: string;
  readonly stepNumber?: number;
  readonly category: FoodSafetyCategory;
  readonly minimumCelsius: number;
}

export interface RequiredFoodSafetyRule {
  readonly category: FoodSafetyCategory;
  readonly minimumCelsius: number;
  readonly ingredientName: string;
}

const CATEGORY_LABELS: Readonly<Record<FoodSafetyCategory, string>> = {
  poultry: '禽肉',
  ground_meat: '肉末或肉馅',
  whole_cut: '整切肉',
  seafood: '水产',
  egg: '蛋类',
  leftovers: '剩菜剩饭',
};

const MINIMUM_TEMPERATURES: Readonly<Record<FoodSafetyCategory, number>> = {
  poultry: 74,
  ground_meat: 71,
  whole_cut: 63,
  seafood: 63,
  egg: 71,
  leftovers: 74,
};

const CATEGORY_PATTERNS: readonly [FoodSafetyCategory, RegExp][] = [
  ['leftovers', /(?:剩饭|剩菜|隔夜(?:饭|菜|熟食)|剩余熟食|复热熟食)/u],
  ['poultry', /(?:鸡|鸭|鹅|火鸡|鸽|鹌鹑)(?:肉|腿|翅|胸|排|块|丁|柳|胗|肝|心)?/u],
  ['ground_meat', /(?:肉末|肉馅|绞肉|碎肉|肉丸|汉堡肉|肉饼)/u],
  ['seafood', /(?:鱼|虾|蟹|贝|蛤|蚝|螺|鱿鱼|章鱼|墨鱼|海鲜|水产|龙虾)/u],
  ['egg', /(?:鸡蛋|鸭蛋|鹅蛋|鹌鹑蛋|禽蛋|蛋液|蛋黄|蛋白)/u],
  ['whole_cut', /(?:牛肉|猪肉|羊肉|牛排|猪排|羊排|排骨|里脊|五花肉|肉块)/u],
] as const;

const DANGEROUS_PREPARATION_PATTERN = /(?:生吃|生食|刺身|半生|不熟|三分熟|五分熟|七分熟|溏心|流心|不(?:要|用|必|需).{0,8}(?:加热|煮熟|熟透)|免(?:加热|煮熟)|低于.{0,6}(?:℃|°c|摄氏|度)|去掉.{0,8}(?:安全|温度|熟透))/iu;
const SAFE_NEGATION_PATTERN = /(?:不要|不可|禁止|拒绝|避免)(?:生吃|生食|半生|不熟)|(?:必须|务必|需要)(?:完全)?(?:煮熟|熟透)/giu;
const WEAKENING_SAFETY_PATTERN = /(?:生吃|生食|刺身|半生|不熟|三分熟|五分熟|七分熟|溏心|流心|无需.{0,8}(?:熟透|加热|温度)|不必.{0,8}(?:熟透|加热|温度)|低于.{0,6}(?:℃|°c|摄氏|度))/iu;
const TEMPERATURE_CONTEXT_PATTERN = /(?:中心|内部|核心|达到|至少|不低于|加热至|复热至|煮至|熟透|食品安全)/u;

const normalizeIdentity = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\p{P}\p{S}\s]+/gu, '')
  .trim();

export const classifyFoodSafetyCategory = (
  ingredientName: string,
): FoodSafetyCategory | undefined => {
  const normalized = normalizeIdentity(ingredientName);
  return CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0];
};

const parseMinimumTemperatureCelsius = (value: string): number | undefined => {
  if (!TEMPERATURE_CONTEXT_PATTERN.test(value)) {
    return undefined;
  }

  const celsiusValues = [...value.matchAll(
    /(-?\d{1,3}(?:\.\d+)?)\s*(?:°\s*c|℃|摄氏(?:度)?)/giu,
  )].map((match) => Number(match[1])).filter(Number.isFinite);
  const fahrenheitValues = [...value.matchAll(
    /(-?\d{1,3}(?:\.\d+)?)\s*(?:°\s*f|℉|华氏(?:度)?)/giu,
  )].map((match) => (Number(match[1]) - 32) * 5 / 9).filter(Number.isFinite);
  const informalCelsiusValues = [...value.matchAll(
    /(?:中心|内部|核心|达到|至少|不低于|加热至|复热至|煮至)\D{0,8}(\d{1,3}(?:\.\d+)?)\s*度/gu,
  )].map((match) => Number(match[1])).filter(Number.isFinite);
  const values = [
    ...celsiusValues,
    ...fahrenheitValues,
    ...informalCelsiusValues,
  ];
  return values.length === 0 ? undefined : Math.max(...values);
};

const requestSafetyText = (request: RecipeVariantPreviewInput): string => [
  ...request.dietaryRequirements,
  ...request.substitutions.flatMap((substitution) => [
    substitution.ingredient,
    substitution.replacement ?? '',
    substitution.reason ?? '',
  ]),
  request.customRequirements ?? '',
].join('\n').normalize('NFKC');

export const findUnsafeRecipeRequestIssues = (
  request: RecipeVariantPreviewInput,
): FoodSafetyIssue[] => {
  const text = requestSafetyText(request).replace(SAFE_NEGATION_PATTERN, '');
  if (!DANGEROUS_PREPARATION_PATTERN.test(text)) {
    return [];
  }

  const categories = CATEGORY_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([category]) => category);
  return [...new Set(categories)].map((category) => ({
    code: 'unsafe_raw_request' as const,
    category,
    minimumCelsius: MINIMUM_TEMPERATURES[category],
  }));
};

export const requiredFoodSafetyRules = (
  recipe: Pick<RecipeVariant, 'ingredients' | 'steps'>,
): RequiredFoodSafetyRule[] => {
  const referencedNames = new Set(recipe.steps.flatMap((step) => (
    step.ingredientNames.map(normalizeIdentity)
  )));
  return recipe.ingredients.flatMap((ingredient) => {
    const category = classifyFoodSafetyCategory(ingredient.name);
    if (
      category === undefined
      || (ingredient.optional && !referencedNames.has(normalizeIdentity(ingredient.name)))
    ) {
      return [];
    }
    return [{
      category,
      minimumCelsius: MINIMUM_TEMPERATURES[category],
      ingredientName: ingredient.name,
    }];
  });
};

const sourceMinimumForIngredient = (
  source: VariantSourceRecipe,
  ingredientName: string,
): number | undefined => {
  const identity = normalizeIdentity(ingredientName);
  const values = source.steps
    .filter((step) => step.ingredientNames.some((name) => (
      normalizeIdentity(name) === identity
    )))
    .flatMap((step) => {
      if (step.safetyRequirement === null) {
        return [];
      }
      const temperature = parseMinimumTemperatureCelsius(
        step.safetyRequirement,
      );
      return temperature === undefined ? [] : [temperature];
    });
  return values.length === 0 ? undefined : Math.max(...values);
};

export const validateFoodSafety = (
  source: VariantSourceRecipe,
  recipe: RecipeVariant,
): {
  readonly issues: readonly FoodSafetyIssue[];
  readonly warnings: readonly string[];
} => {
  const issues: FoodSafetyIssue[] = [];
  const warnings: string[] = [];
  for (const rule of requiredFoodSafetyRules(recipe)) {
    const sourceMinimum = sourceMinimumForIngredient(source, rule.ingredientName);
    const requiredMinimum = Math.max(
      rule.minimumCelsius,
      sourceMinimum ?? rule.minimumCelsius,
    );
    const identity = normalizeIdentity(rule.ingredientName);
    const relevantSteps = recipe.steps.filter((step) => (
      step.ingredientNames.some((name) => normalizeIdentity(name) === identity)
    ));
    const safetySteps = relevantSteps.filter((step) => (
      step.safetyRequirement !== undefined
      && step.safetyRequirement.length > 0
    ));

    if (safetySteps.length === 0) {
      issues.push({
        code: 'missing_safety_requirement',
        ingredientName: rule.ingredientName,
        category: rule.category,
        minimumCelsius: requiredMinimum,
      });
      continue;
    }

    const hasWeakeningInstruction = safetySteps.some((step) => (
      WEAKENING_SAFETY_PATTERN.test(step.safetyRequirement ?? '')
    ));
    if (hasWeakeningInstruction) {
      const step = safetySteps.find((candidate) => (
        WEAKENING_SAFETY_PATTERN.test(candidate.safetyRequirement ?? '')
      ));
      issues.push({
        code: 'unsafe_safety_instruction',
        ingredientName: rule.ingredientName,
        ...(step === undefined ? {} : { stepNumber: step.number }),
        category: rule.category,
        minimumCelsius: requiredMinimum,
      });
      continue;
    }

    const observedMaximum = Math.max(
      ...safetySteps.map((step) => (
        parseMinimumTemperatureCelsius(step.safetyRequirement ?? '')
          ?? Number.NEGATIVE_INFINITY
      )),
    );
    if (observedMaximum + Number.EPSILON < requiredMinimum) {
      issues.push({
        code: 'insufficient_internal_temperature',
        ingredientName: rule.ingredientName,
        category: rule.category,
        minimumCelsius: requiredMinimum,
      });
      continue;
    }

    warnings.push(
      `${rule.ingredientName}（${CATEGORY_LABELS[rule.category]}）的中心温度至少达到 ${requiredMinimum}°C。`,
    );
  }

  return { issues, warnings: [...new Set(warnings)] };
};

