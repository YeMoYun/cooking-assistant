import type { RecipeImport } from '@xiaochu/shared';

export type RecipeIngredient = RecipeImport['ingredients'][number];
export type EnrichedStep = RecipeImport['steps'][number];

export interface StepEnrichmentInput {
  readonly instruction: string;
  readonly number: number;
  readonly ingredients: readonly RecipeIngredient[];
  readonly previousInstruction?: string;
  readonly nextInstruction?: string;
}

export type ActionKind =
  | 'prep'
  | 'rest'
  | 'stir-fry'
  | 'pan-fry'
  | 'deep-fry'
  | 'boil'
  | 'stew'
  | 'steam'
  | 'bake'
  | 'serve';

interface Guidance {
  readonly heat: string;
  readonly cue: string;
  readonly mistake: string;
  readonly safety: string;
}

const DEFAULT_DURATION_SECONDS: Readonly<Record<ActionKind, readonly [number, number]>> = {
  prep: [60, 300],
  rest: [600, 1_800],
  'stir-fry': [60, 180],
  'pan-fry': [120, 300],
  'deep-fry': [180, 360],
  boil: [300, 900],
  stew: [1_800, 5_400],
  steam: [600, 1_800],
  bake: [900, 1_800],
  serve: [30, 60],
};

const GUIDANCE: Readonly<Record<ActionKind, Guidance>> = {
  prep: {
    heat: '无需开火，使用合适的备料工具',
    cue: '食材处理到原步骤要求的大小和状态，并分别放置',
    mistake: '切配大小差异过大会让后续成熟速度不一致',
    safety: '刀具远离手指；接触生肉后清洗双手、刀具和砧板',
  },
  rest: {
    heat: '无需开火，按原步骤要求室温静置或冷藏',
    cue: '达到入味、泡软、醒发或冷却所需的状态',
    mistake: '静置不足会影响入味和组织，环境温度过高则容易变质',
    safety: '含生肉、蛋奶的食材静置超过20分钟时应放入冰箱冷藏',
  },
  'stir-fry': {
    heat: '燃气灶中大火，炒锅',
    cue: '食材受热均匀、香气明显，水汽减少且没有焦黑',
    mistake: '锅温不足或一次放入过多食材会大量出水，影响香味和口感',
    safety: '食材下锅前沥干表面水分，身体与面部避开可能飞溅的热油',
  },
  'pan-fry': {
    heat: '燃气灶中小火，平底锅',
    cue: '接触锅面的两面均匀上色，中心达到对应食材的成熟状态',
    mistake: '火力过大会造成外焦里生，过早翻面则容易粘锅破损',
    safety: '翻面时降低动作幅度并使用长柄锅铲，避免油滴飞溅',
  },
  'deep-fry': {
    heat: '燃气灶中火，油温约160～180℃',
    cue: '表面颜色均匀金黄，外层定型且内部完全熟透',
    mistake: '油温过低会吸油，油温过高会外焦里生',
    safety: '锅内油量不超过锅深的一半，带水食材不得直接放入油锅',
  },
  boil: {
    heat: '燃气灶大火烧开后转中火',
    cue: '液体保持稳定沸腾，食材达到原步骤要求的软硬度',
    mistake: '全程大火会导致汤汁过度翻滚、浑浊或溢锅',
    safety: '锅盖留缝，开盖时让蒸汽朝远离身体的方向散出',
  },
  stew: {
    heat: '燃气灶烧开后转小火，保持轻微冒泡',
    cue: '汤汁浓度合适，食材软熟入味但没有散碎',
    mistake: '沸腾过猛会使肉质变柴，也会让汤汁过快蒸发',
    safety: '中途检查液面，汤汁不足时补热水，避免干烧',
  },
  steam: {
    heat: '蒸锅上汽后保持中大火',
    cue: '食材中心熟透，表面没有生粉、血水或未凝固液体',
    mistake: '冷水入锅后直接计时会导致实际加热时间不足',
    safety: '开盖时先关火，并让蒸汽朝远离身体的方向散出',
  },
  bake: {
    heat: '烤箱提前预热至180℃，使用中层烤架',
    cue: '表面均匀上色，中心熟透且没有生面糊或血水',
    mistake: '未预热或频繁开门会导致受热不均和烘烤时间失准',
    safety: '取放烤盘必须使用隔热手套，并避免接触加热管',
  },
  serve: {
    heat: '无需开火，使用洁净餐具',
    cue: '装盘完整，台面和盘边没有多余汤汁或残渣',
    mistake: '成菜放置过久会影响温度、香气和口感',
    safety: '热菜使用隔热工具，盛放生食和熟食的餐具要分开',
  },
};

const HEAT_PATTERN = /(大火|中大火|中火|中小火|小火|微火|文火|猛火|低火|高火|\d{2,3}\s*(?:℃|度))/u;
const TIME_PATTERN = /(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*(?:秒钟?|分钟?|小时|个小时)/u;
const MEAT_PATTERN = /(肉|鸡|鸭|鹅|排骨|猪|牛|羊)/u;
const SEAFOOD_PATTERN = /(鱼|虾|蟹|贝|蛤|蚝|鱿鱼|墨鱼)/u;
const EGG_PATTERN = /(蛋|鸡蛋|鸭蛋|鹌鹑蛋)/u;
const WOOD_EAR_PATTERN = /木耳/u;

const ACTION_RULES: readonly [ActionKind, RegExp][] = [
  ['deep-fry', /(油炸|炸至|炸制|复炸|下油锅炸|炸熟|炸香|炸酥)/u],
  ['stew', /(炖|焖|煲|煨|收汁|小火煮|慢煮)/u],
  ['stir-fry', /(炒|爆香|翻炒|煸炒|炒香|炒匀|炒熟|快炒|下锅炒|炒至)/u],
  ['pan-fry', /(煎|烙|煎至|煎熟)/u],
  ['steam', /(蒸|上汽|蒸熟|蒸制)/u],
  ['bake', /(烤箱|烘烤|烤制|烤至|烤熟)/u],
  ['boil', /(烧开|煮沸|煮开|焯水|汆烫|水开|煮至|煮熟|下锅煮|煮)/u],
  ['rest', /(腌|浸泡|泡发|泡软|泡入|醒发|静置|冷藏|冷却|晾凉|发酵|松弛)/u],
  ['serve', /(装盘|出锅|盛出|享用|撒上|点缀|摆盘)/u],
];

const normalizeInstruction = (value: string): string => value
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .replace(/[。；;，,\s]+$/gu, '')
  .trim()
  .slice(0, 1_700);

const chineseInteger = (value: string): number | undefined => {
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  if (value === '半') return 0.5;
  const digit: Readonly<Record<string, number>> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (value === '十') return 10;
  const tenIndex = value.indexOf('十');
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digit[value[tenIndex - 1] ?? ''];
    const ones = tenIndex === value.length - 1 ? 0 : digit[value[tenIndex + 1] ?? ''];
    if (tens !== undefined && ones !== undefined) return tens * 10 + ones;
  }
  if (value.length === 1) return digit[value];
  return undefined;
};

const secondsFor = (value: number, unit: string): number => {
  if (unit.startsWith('秒')) return value;
  if (unit.startsWith('分')) return value * 60;
  return value * 3_600;
};

const boundedSeconds = (value: number): number => Math.round(Math.max(10, Math.min(28_800, value)));

export const parseDurationSeconds = (instruction: string): readonly [number, number] | undefined => {
  const normalized = instruction.normalize('NFKC');
  const halfHour = /半\s*(?:个)?小时/u.exec(normalized);
  if (halfHour !== null) return [1_800, 1_800];

  const range = /([\d.]+|[一二两三四五六七八九十]+)\s*(?:-|~|～|—|至|到)\s*([\d.]+|[一二两三四五六七八九十]+)\s*(秒钟?|分钟?|小时|个小时)/u.exec(normalized);
  if (range !== null) {
    const first = chineseInteger(range[1] ?? '');
    const second = chineseInteger(range[2] ?? '');
    const unit = range[3] ?? '';
    if (first !== undefined && second !== undefined) {
      return [boundedSeconds(secondsFor(Math.min(first, second), unit)), boundedSeconds(secondsFor(Math.max(first, second), unit))];
    }
  }

  const adjacentRange = /([一二两三四五六七八九])([二三四五六七八九])\s*(秒钟?|分钟?|小时|个小时)/u.exec(normalized);
  if (adjacentRange !== null) {
    const first = chineseInteger(adjacentRange[1] ?? '');
    const second = chineseInteger(adjacentRange[2] ?? '');
    const unit = adjacentRange[3] ?? '';
    if (first !== undefined && second !== undefined) {
      return [boundedSeconds(secondsFor(Math.min(first, second), unit)), boundedSeconds(secondsFor(Math.max(first, second), unit))];
    }
  }

  const single = /([\d.]+|[一二两三四五六七八九十]+)\s*(秒钟?|分钟?|小时|个小时)\s*(?:左右|以上|以内|即可|后)?/u.exec(normalized);
  if (single === null) return undefined;
  const value = chineseInteger(single[1] ?? '');
  if (value === undefined) return undefined;
  const seconds = boundedSeconds(secondsFor(value, single[2] ?? ''));
  if (/(左右|约|大约)/u.test(normalized)) {
    return [boundedSeconds(seconds * 0.85), boundedSeconds(seconds * 1.15)];
  }
  return [seconds, seconds];
};

export const classifyStepAction = (instruction: string): ActionKind => {
  for (const [action, pattern] of ACTION_RULES) {
    if (pattern.test(instruction)) return action;
  }
  return 'prep';
};

const ingredientNamesFor = (
  instruction: string,
  ingredients: readonly RecipeIngredient[],
): string[] => {
  const normalized = instruction.normalize('NFKC').toLocaleLowerCase('zh-CN');
  return ingredients.flatMap((ingredient) => {
    const matched = [ingredient.canonicalName, ...ingredient.aliases].some((name) => (
      normalized.includes(name.normalize('NFKC').toLocaleLowerCase('zh-CN'))
    ));
    return matched ? [ingredient.canonicalName] : [];
  });
};

const durationText = ([minimum, maximum]: readonly [number, number]): string => {
  const render = (seconds: number): string => {
    if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600}小时`;
    if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}分钟`;
    return `${seconds}秒`;
  };
  return minimum === maximum ? render(minimum) : `${render(minimum)}～${render(maximum)}`;
};

const foodSpecificGuidance = (
  instruction: string,
  action: ActionKind,
  ingredientNames: readonly string[],
  base: Guidance,
): Guidance => {
  const foods = `${instruction}${ingredientNames.join('')}`;
  const meatFoods = foods.replace(/(?:鸡|鸭|鹅|鹌鹑)?蛋(?:液|黄|白)?/gu, '');
  let cue = base.cue;
  let safety = base.safety;
  if (action !== 'prep' && action !== 'rest' && action !== 'serve' && MEAT_PATTERN.test(meatFoods)) {
    cue = `${cue}；肉类切开后中心无血水、颜色一致`;
  }
  if (action !== 'prep' && action !== 'rest' && action !== 'serve' && SEAFOOD_PATTERN.test(foods)) {
    cue = `${cue}；海鲜整体变得不透明，虾蟹外壳变色且肉质紧实`;
  }
  if (action !== 'prep' && action !== 'rest' && action !== 'serve' && EGG_PATTERN.test(foods)) {
    cue = `${cue}；蛋液应完全凝固，不保留流动生蛋液`;
  }
  if ((action === 'stir-fry' || action === 'pan-fry' || action === 'deep-fry') && WOOD_EAR_PATTERN.test(foods)) {
    safety = `${safety}；木耳和表面含水食材必须充分沥干再下锅`;
  }
  return { ...base, cue, safety };
};

export const enrichRecipeStep = (input: StepEnrichmentInput): EnrichedStep => {
  const original = normalizeInstruction(input.instruction);
  const action = classifyStepAction(original);
  const duration = parseDurationSeconds(original) ?? DEFAULT_DURATION_SECONDS[action];
  const ingredientNames = ingredientNamesFor(original, input.ingredients);
  const guidance = foodSpecificGuidance(original, action, ingredientNames, GUIDANCE[action]);
  const hasHeat = HEAT_PATTERN.test(original);
  const hasTime = TIME_PATTERN.test(original) || parseDurationSeconds(original) !== undefined;
  const addition = action === 'prep' || action === 'rest' || action === 'serve'
    ? `这一步预计需要${durationText(duration)}，${guidance.cue}。`
    : hasHeat && !hasTime
      ? `按原步骤标明的火力继续操作${durationText(duration)}，${guidance.cue}。`
      : !hasHeat && hasTime
        ? `使用${guidance.heat}按原步骤时长操作，${guidance.cue}。`
        : `使用${guidance.heat}操作${durationText(duration)}，${guidance.cue}。`;
  const instruction = `${original}。${hasHeat && hasTime ? `以“${guidance.cue}”作为完成标准。` : addition}`
    .replace(/。{2,}/gu, '。')
    .slice(0, 2_000);

  return {
    number: input.number,
    instruction,
    ingredientNames,
    durationSecondsMin: duration[0],
    durationSecondsMax: duration[1],
    heatOrDevice: hasHeat
      ? `按原步骤标明的火力或温度操作；推荐设备：${guidance.heat}`
      : guidance.heat,
    completionCue: guidance.cue,
    commonMistake: guidance.mistake,
    safetyRequirement: guidance.safety,
  };
};

export const stepHasRecognizedAction = (instruction: string): boolean => (
  ACTION_RULES.some(([, pattern]) => pattern.test(instruction))
);
